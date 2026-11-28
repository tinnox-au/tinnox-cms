#!/usr/bin/env bash
# Runs TINNOX's membership provisioning tool (scripts/provision-member.ts) against a
# deployed environment. A person runs it in AWS CloudShell, from a checkout of the
# commit that is released, with their own rights:
#
#   infra/aws/provision.sh test --help
#   infra/aws/provision.sh test org-create --org-name 'Example' --timezone Australia/Sydney \
#       --owner 'pat@example.com=Pat Example' --request-ref R-1 --executed-by pat
#
# The first argument is the environment; everything after it goes to the tool unchanged.
# A username is the person's e-mail address, and their account must exist in the user
# pool first (Cognito console, or `aws cognito-idp admin-create-user`).
#
# The tool is never run on the API's server (docs/portal-v2/stage-c.md, section 8.2). It
# runs here, in a container built from this checkout, and reaches the database through a
# Session Manager port forward that passes through the server without running anything
# on it. It uses, for as long as it runs and no longer:
#   - the migrator's connection string, read from Parameter Store with your rights;
#   - your temporary AWS credentials, to look the person up in the user pool
#     (cognito-idp:AdminGetUser).
# Both are in the container's environment in this CloudShell only; nothing is written to
# Parameter Store, to the server or to the repository.
set -Eeuo pipefail
umask 077

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

environment=${1:-}
[[ $environment =~ ^[a-z][a-z0-9]{1,11}$ ]] || usage
shift
[ "$#" -ge 1 ] || usage

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repository=$(cd "$here/../.." && pwd)
readonly here repository
readonly STACK="tinnox-cms-$environment"
readonly PARAMETERS="/tinnox-cms/$environment"
readonly IMAGE=tinnox-cms-provision:local

say() { printf '%s\n' "$*" >&2; }
fail() {
  say "FAILED: $*"
  exit 1
}

for tool in aws docker session-manager-plugin; do
  command -v "$tool" >/dev/null || fail "$tool is not installed (AWS CloudShell has it)"
done

output_of() {
  local value
  value=$(aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text)
  [ -n "$value" ] && [ "$value" != None ] || fail "stack $1 has no output $2"
  printf '%s' "$value"
}

instance=$(output_of "$STACK" ServerInstanceId)
database_host=$(output_of "$STACK-database" DatabaseHost)
database_port=$(output_of "$STACK-database" DatabasePort)
issuer=$(output_of "$STACK-identity" Issuer)

say "Environment $environment, commit $(git -C "$repository" rev-parse --short HEAD 2>/dev/null || echo unknown)"
say 'Building the provisioning image from this checkout ...'
docker build --quiet --file "$repository/apps/api/Dockerfile" --target provision \
  --tag "$IMAGE" "$repository" >/dev/null

# The port forward: this machine's port to the database, through the server. The
# connection string names the database's own host name, which the container is told is
# this machine, so the certificate is still checked against that name.
work=$(mktemp -d)
readonly work
forward=''
cleanup() {
  if [ -n "$forward" ]; then
    kill -- "-$forward" 2>/dev/null || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT

if (exec 3<>"/dev/tcp/127.0.0.1/$database_port") 2>/dev/null; then
  fail "port $database_port is already in use on this machine"
fi
say "Opening a port forward to the database through server $instance ..."
setsid bash -c 'tail -f /dev/null | aws ssm start-session --target "$1" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$2,portNumber=$3,localPortNumber=$3"' \
  forward "$instance" "$database_host" "$database_port" >"$work/forward.log" 2>&1 &
forward=$!
opened=0
for _ in $(seq 1 30); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$database_port") 2>/dev/null; then
    opened=1
    break
  fi
  kill -0 "$forward" 2>/dev/null || break
  sleep 1
done
[ "$opened" = 1 ] || fail "the port forward did not open: $(tail -n 3 "$work/forward.log" | tr '\n' ' ')"

status=0
(
  DATABASE_MIGRATOR_URL=$(aws ssm get-parameter --name "$PARAMETERS/migrator/DATABASE_MIGRATOR_URL" \
    --with-decryption --query Parameter.Value --output text)
  eval "$(aws configure export-credentials --format env)"
  export DATABASE_MIGRATOR_URL PROVISION_IDP_ISSUER="$issuer"
  terminal=()
  if [ -t 0 ] && [ -t 1 ]; then terminal=(--tty); fi
  docker run --rm --interactive "${terminal[@]}" --network host \
    --add-host "$database_host:127.0.0.1" \
    --read-only --user 10002:10002 --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --env DATABASE_MIGRATOR_URL --env PROVISION_IDP_ISSUER \
    --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY --env AWS_SESSION_TOKEN \
    "$IMAGE" "$@"
) || status=$?
exit "$status"
