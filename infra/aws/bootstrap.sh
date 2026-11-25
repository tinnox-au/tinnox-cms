#!/usr/bin/env bash
# Prepares a deployed environment for its first release, after its three stacks exist
# (README.md, section 3). A person runs it in AWS CloudShell, from a checkout of this
# repository, with their own rights:
#
#   infra/aws/bootstrap.sh test
#   infra/aws/bootstrap.sh test --rotate-database-passwords
#
# It does two things, and may be run again at any time:
#
#   1. The database roles and the database (rds-roles.sql), run on the server, which is
#      the only machine that reaches the database. The server gets the master password
#      for those minutes, as an encrypted parameter that this script deletes again.
#   2. The settings of the API and the migrator's connection string, in Parameter Store
#      under /tinnox-cms/<environment>/, encrypted with the environment's key.
#
# Passwords and secrets are made here, 256 random bits each, and are never printed. The
# database gets SCRAM verifiers, not passwords. A secret that already exists is kept:
# database passwords change only with --rotate-database-passwords (the API then needs a
# release to read its new one), the three application secrets never change here.
#
# Parameter Store is the truth for the two database passwords. A new one is stored there
# first, and every run then sets the database's passwords to what is stored. So a run
# that stops half way is repaired by running the script again, with or without the flag.
set -Eeuo pipefail
umask 077

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

environment=${1:-}
rotate=0
[[ $environment =~ ^[a-z][a-z0-9]{1,11}$ ]] || usage
shift
for argument in "$@"; do
  case "$argument" in
    --rotate-database-passwords) rotate=1 ;;
    *) usage ;;
  esac
done

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly here
readonly STACK="tinnox-cms-$environment"
readonly PARAMETERS="/tinnox-cms/$environment"
readonly KEY="alias/tinnox-cms-$environment-secrets"
readonly TEMPORARY="$PARAMETERS/tmp/master-password"
# The same image as the local database (infra/docker-compose.yml), for its psql.
readonly PSQL_IMAGE='postgres:17.12-alpine3.24@sha256:d3244e8ce3f165ee3c93d9c4a4b1d0fe48b3a89e2287b717fdcbbde92d405065'
# The same bundle and checksum as apps/api/Dockerfile.
readonly CA_URL='https://truststore.pki.rds.amazonaws.com/ap-southeast-2/ap-southeast-2-bundle.pem'
readonly CA_SHA256='d73890748b5a95551800df8a6f07c9c800e32ed34da7e6c9505918bf8ac2398b'
readonly CA_PATH_IN_IMAGES='/etc/ssl/rds/ap-southeast-2-bundle.pem'

say() { printf '%s\n' "$*"; }
fail() {
  say "FAILED: $*" >&2
  exit 1
}

for tool in aws jq python3 openssl; do
  command -v "$tool" >/dev/null || fail "$tool is not installed (AWS CloudShell has it)"
done

output_of() {
  local value
  value=$(aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text)
  [ -n "$value" ] && [ "$value" != None ] || fail "stack $1 has no output $2"
  printf '%s' "$value"
}

# Only "there is no such parameter" counts as absent. Any other failure stops the script:
# taking an error for absence would make new secrets over ones that exist.
parameter_exists() {
  local problem
  if problem=$(aws ssm get-parameter --name "$1" --query Parameter.Name --output text 2>&1 >/dev/null); then
    return 0
  fi
  case "$problem" in
    *ParameterNotFound*) return 1 ;;
    *) fail "could not read whether $1 exists: $problem" ;;
  esac
}

# name, value. The value reaches the AWS CLI in a file only this user can read, not on a
# command line, where other processes could see it.
put_secret() {
  VALUE="$2" jq -n '{Value: env.VALUE}' >"$work/value.json"
  aws ssm put-parameter --name "$1" --type SecureString --key-id "$KEY" --overwrite \
    --cli-input-json "file://$work/value.json" >/dev/null
  rm -f "$work/value.json"
}

# A secret that is made once. Without --overwrite: if it exists after all, the call fails
# and the script stops rather than replace it.
put_new_secret() {
  VALUE="$2" jq -n '{Value: env.VALUE}' >"$work/value.json"
  aws ssm put-parameter --name "$1" --type SecureString --key-id "$KEY" \
    --cli-input-json "file://$work/value.json" >/dev/null
  rm -f "$work/value.json"
}

# The password inside a stored connection string, for the role named. Nothing is printed
# but the password, to the caller.
password_in() { # parameter name, role
  aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text |
    ROLE="$2" python3 -c '
import os, sys, urllib.parse
url = urllib.parse.urlsplit(sys.stdin.read().strip())
if url.username != os.environ["ROLE"] or not url.password:
    sys.exit("the stored connection string does not name " + os.environ["ROLE"] + " with a password")
print(urllib.parse.unquote(url.password))
'
}

put_plain() {
  VALUE="$2" jq -n '{Value: env.VALUE}' >"$work/value.json"
  aws ssm put-parameter --name "$1" --type String --overwrite \
    --cli-input-json "file://$work/value.json" >/dev/null
  rm -f "$work/value.json"
}

random_secret() { openssl rand -hex 32; }

# A SCRAM-SHA-256 verifier in PostgreSQL's format, for a password of plain ASCII. The
# password is read from standard input.
scram_verifier() {
  python3 -c '
import base64, hashlib, hmac, os, sys
password = sys.stdin.read().strip().encode("ascii")
salt, rounds = os.urandom(16), 4096
salted = hashlib.pbkdf2_hmac("sha256", password, salt, rounds)
stored = hashlib.sha256(hmac.new(salted, b"Client Key", "sha256").digest()).digest()
server = hmac.new(salted, b"Server Key", "sha256").digest()
b64 = lambda raw: base64.b64encode(raw).decode()
print(f"SCRAM-SHA-256${rounds}:{b64(salt)}${b64(stored)}:{b64(server)}")
'
}

work=$(mktemp -d)
readonly work
cleanup() {
  local problem
  if ! problem=$(aws ssm delete-parameter --name "$TEMPORARY" 2>&1 >/dev/null); then
    case "$problem" in
      *ParameterNotFound*) ;;
      *) say "WARNING: the master password may still be in $TEMPORARY: delete that parameter by hand ($problem)" >&2 ;;
    esac
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT

say "Environment $environment, account $(aws sts get-caller-identity --query Account --output text), Region ${AWS_REGION:-${AWS_DEFAULT_REGION:-unknown}}"

instance=$(output_of "$STACK" ServerInstanceId)
portal_origin=$(output_of "$STACK" PortalOrigin)
player_origin=$(output_of "$STACK" PlayerOrigin)
database_host=$(output_of "$STACK-database" DatabaseHost)
database_port=$(output_of "$STACK-database" DatabasePort)
master_secret=$(output_of "$STACK-database" MasterUserSecretArn)
issuer=$(output_of "$STACK-identity" Issuer)
client_id=$(output_of "$STACK-identity" ClientId)
user_pool=$(output_of "$STACK-identity" UserPoolId)

# ---------------------------------------------------------------- 1. database
readonly MIGRATOR_PARAMETER="$PARAMETERS/migrator/DATABASE_MIGRATOR_URL"
readonly APP_PARAMETER="$PARAMETERS/api/DATABASE_URL"
query="sslmode=verify-full&sslrootcert=$CA_PATH_IN_IMAGES"
new_passwords=0
if [ "$rotate" = 1 ] || ! parameter_exists "$APP_PARAMETER" || ! parameter_exists "$MIGRATOR_PARAMETER"; then
  new_passwords=1
  put_secret "$MIGRATOR_PARAMETER" \
    "postgresql://tinnox_migrator:$(random_secret)@$database_host:$database_port/tinnox?$query"
  put_secret "$APP_PARAMETER" \
    "postgresql://tinnox_app:$(random_secret)@$database_host:$database_port/tinnox?$query"
  say 'Stored new connection strings for tinnox_migrator and tinnox_app.'
else
  say 'The stored database passwords are kept.'
fi
# Always from what is stored, so the database ends up agreeing with Parameter Store.
migrator_verifier=$(password_in "$MIGRATOR_PARAMETER" tinnox_migrator | scram_verifier)
app_verifier=$(password_in "$APP_PARAMETER" tinnox_app | scram_verifier)
[[ $migrator_verifier == SCRAM-SHA-256\$* && $app_verifier == SCRAM-SHA-256\$* ]] ||
  fail 'could not make the password verifiers'

put_secret "$TEMPORARY" "$(aws secretsmanager get-secret-value --secret-id "$master_secret" \
  --query SecretString --output text | jq -r .password)"

# What runs on the server. It holds no secret: the verifiers are not passwords, and the
# master password is read on the server from the temporary parameter into a password file
# in /run, which is memory, not disk. psql reads that file; the password is in no
# environment, so Docker does not write it into the container's settings on the data disk.
{
  cat <<SERVER
#!/bin/bash
set -Eeuo pipefail
umask 077
export HOME=/root
export AWS_DEFAULT_REGION='${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-southeast-2}}'
work=\$(mktemp -d /run/tinnox-bootstrap.XXXXXX)
trap 'rm -rf "\$work"' EXIT
curl -fsS -m 60 -o "\$work/ca.pem" '$CA_URL'
echo '$CA_SHA256  '"\$work/ca.pem" | sha256sum -c - >/dev/null
chmod 0444 "\$work/ca.pem"
docker pull --quiet '$PSQL_IMAGE' >/dev/null
aws ssm get-parameter --name '$TEMPORARY' --with-decryption --query Parameter.Value --output text |
  sed -e 's/[\\\\:]/\\\\&/g' -e 's/^/*:*:*:tinnox_master:/' >"\$work/pgpass"
chmod 0600 "\$work/pgpass"
docker run --rm -i --log-driver none --env PGPASSFILE=/pgpass \\
  -v "\$work/ca.pem:/ca.pem:ro" -v "\$work/pgpass:/pgpass:ro" '$PSQL_IMAGE' \\
  psql 'host=$database_host port=$database_port dbname=postgres user=tinnox_master sslmode=verify-full sslrootcert=/ca.pem' \\
  -X -q -v migrator_verifier='$migrator_verifier' -v app_verifier='$app_verifier' <<'SQL'
SERVER
  cat "$here/rds-roles.sql"
  printf 'SQL\n'
} >"$work/server.sh"
jq -n --rawfile script "$work/server.sh" '{commands: [$script], executionTimeout: ["600"]}' >"$work/parameters.json"

say "Setting up the roles and the database through server $instance ..."
command_id=$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
  --comment "tinnox-cms $environment: database roles" \
  --parameters "file://$work/parameters.json" --query Command.CommandId --output text)
status=InProgress
for _ in $(seq 1 120); do
  sleep 5
  status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" \
    --query Status --output text 2>/dev/null || echo Pending)
  case "$status" in Pending | InProgress | Delayed) ;; *) break ;; esac
done
aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" \
  --query '[StandardOutputContent, StandardErrorContent]' --output text
[ "$status" = Success ] ||
  fail "the database set-up ended as $status. The stored connection strings may not match the database yet: correct the cause and run this script again, which sets the database's passwords to what is stored"

# ---------------------------------------------------------------- 2. settings
for name in SESSION_SECRET MEDIA_URL_HMAC_SECRET PAIRING_CLIENT_KEY_SECRET; do
  if parameter_exists "$PARAMETERS/api/$name"; then
    say "Kept api/$name."
  else
    put_new_secret "$PARAMETERS/api/$name" "$(random_secret)"
    say "Made api/$name."
  fi
done

put_secret "$PARAMETERS/api/OIDC_CLIENT_SECRET" "$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$user_pool" --client-id "$client_id" --query UserPoolClient.ClientSecret --output text)"
put_plain "$PARAMETERS/api/OIDC_ISSUER" "$issuer"
put_plain "$PARAMETERS/api/OIDC_CLIENT_ID" "$client_id"
put_plain "$PARAMETERS/api/API_PUBLIC_ORIGIN" "$portal_origin"
put_plain "$PARAMETERS/api/PORTAL_ORIGIN" "$portal_origin"
put_plain "$PARAMETERS/api/PLAYER_ORIGIN" "$player_origin"
put_plain "$PARAMETERS/api/OIDC_REDIRECT_URI" "$portal_origin/api/auth/callback"
put_plain "$PARAMETERS/api/OIDC_POST_LOGOUT_REDIRECT_URI" "$portal_origin/"
say 'Wrote the sign-in settings and the three origins.'

# The API does not start in production without a statement of what proves the second
# factor. Until a real token has been read (README.md, section 5), ask for "mfa" in the
# token's amr claim: if Cognito sends something else, every sign-in is refused, which is
# the safe way to be wrong. A value someone has set is kept.
if parameter_exists "$PARAMETERS/api/OIDC_MFA_AMR_VALUES" ||
  parameter_exists "$PARAMETERS/api/OIDC_MFA_ACR_VALUES"; then
  say 'Kept the proof of the second factor.'
else
  put_plain "$PARAMETERS/api/OIDC_MFA_AMR_VALUES" mfa
  say 'Set api/OIDC_MFA_AMR_VALUES to "mfa" for now: unverified, see README.md, section 5.'
fi

say
say "Parameters under $PARAMETERS now:"
aws ssm get-parameters-by-path --path "$PARAMETERS" --recursive \
  --query 'Parameters[].[Type, Name]' --output text | sort -k2
if [ "$new_passwords" = 1 ]; then
  say
  say 'The database passwords are new: start a release now, so the API reads its new one.'
fi
