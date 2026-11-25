#!/usr/bin/env bash
# Releases one commit of TINNOX CMS on a server (docs/deployment-plan-2026-11-24.md,
# section 3.5, item 6). It runs as root on the server, started by the release document of
# infra/aws/environment.yml, which takes this file and compose.yml out of the release
# image of the commit and sets the variables below. Nothing else starts it.
#
# What it does, in this order:
#   1. pulls the commit's three images, so a missing image fails before anything stops;
#   2. writes the API's settings file from Parameter Store, and refuses a value that the
#      settings file could change on the way (see write_api_settings);
#   3. stops the API, runs the migrations with the migrator's connection string, which
#      only that one container is given, and starts everything again;
#   4. waits until the API's dependencies answer (/readyz).
#
# If a migration fails the API stays stopped: the schema is then between two releases,
# and neither the old code nor the new one is known to be right for it. The portal and
# the player still load; every request to the API fails until a release succeeds.
#
# It prints no setting and no secret. Its output goes back to whoever started the release
# and into /var/log/tinnox-release.log.
set -Eeuo pipefail
umask 077

: "${TINNOX_ENV:?the environment name is required}"
: "${TINNOX_REGION:?the AWS Region is required}"
: "${TINNOX_REGISTRY:?the image registry is required}"
: "${TINNOX_TAG:?the commit to release is required}"
: "${PORTAL_HOST:?the portal host name is required}"
: "${PLAYER_HOST:?the player host name is required}"

# Systems Manager starts commands without HOME; Docker finds the registry sign-in helper
# through it (set in the server set-up).
export HOME=/root
export AWS_DEFAULT_REGION="$TINNOX_REGION"

readonly PROJECT=tinnox-cms-deploy
readonly SETTINGS_DIR=/etc/tinnox
readonly API_ENV_FILE="$SETTINGS_DIR/api.env"
readonly RELEASES_DIR=/var/lib/tinnox/releases
readonly PARAMETERS="/tinnox-cms/$TINNOX_ENV"
readonly KEEP_RELEASES=5
# Where the migrator's connection string rests while the migrations run: memory, not disk.
# Another directory is only for a rehearsal off the server.
readonly RUN_DIR=${TINNOX_RUN_DIR:-/run}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly here

exec > >(tee -a /var/log/tinnox-release.log) 2>&1
readonly tee_pid=$!

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() {
  log "FAILED: $*"
  exit 1
}

# What is said about the API on failure comes from its real state, not from how far the
# script got. The last lines must not be lost, so the script waits for tee before it ends.
finish() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    log "release of $TINNOX_TAG did not finish (exit $status)"
    if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
      --filter label=com.docker.compose.service=api --filter status=running 2>/dev/null)" ]; then
      log 'an API container is running'
    else
      log 'no API container is running: it starts again with the next release that succeeds'
    fi
  fi
  exec >&- 2>&-
  wait "$tee_pid" 2>/dev/null || true
}
trap finish EXIT
trap 'log "error near line $LINENO"' ERR

[[ $TINNOX_TAG =~ ^[0-9a-f]{40}$ ]] || fail 'the tag is not a full commit id'
[[ $TINNOX_ENV =~ ^[a-z][a-z0-9]{1,11}$ ]] || fail 'the environment name is not valid'

# One release at a time. The release document takes this lock before it unpacks the
# release and hands it on as descriptor 9; started any other way, the script takes it.
if ! { true >&9; } 2>/dev/null; then
  exec 9>/run/tinnox-release.lock
fi
flock -n 9 || fail 'another release is running'

export API_IMAGE="$TINNOX_REGISTRY/tinnox-cms/api:$TINNOX_TAG"
export WEB_IMAGE="$TINNOX_REGISTRY/tinnox-cms/web:$TINNOX_TAG"
export WORKER_IMAGE="$TINNOX_REGISTRY/tinnox-cms/media-worker:$TINNOX_TAG"
readonly RELEASE_IMAGE="$TINNOX_REGISTRY/tinnox-cms/release:$TINNOX_TAG"
export PORTAL_HOST PLAYER_HOST API_ENV_FILE

# The settings file is read by Docker Compose, which treats quotes, "$", "#", a backslash
# and spaces in a value specially. Rather than quote, a value may only contain characters
# that Compose passes through unchanged; a setting outside that set is refused by name, so
# what the API reads is exactly what Parameter Store holds. Secrets made by
# infra/aws/bootstrap.sh are hexadecimal, and URLs fit.
write_api_settings() {
  local prefix="$PARAMETERS/api/" listing name value key tmp count=0
  local safe='^[A-Za-z0-9_.:/@?&=%+,~-]+$'
  listing=$(aws ssm get-parameters-by-path --path "$prefix" --with-decryption \
    --query 'Parameters[].[Name,Value]' --output text) ||
    fail "could not read the parameters under $prefix"
  [ -n "$listing" ] || fail "no parameter under $prefix: run infra/aws/bootstrap.sh first"
  mkdir -p "$SETTINGS_DIR"
  tmp=$(mktemp "$SETTINGS_DIR/api.env.XXXXXX")
  while IFS=$'\t' read -r name value; do
    key=${name#"$prefix"}
    if ! [[ $key =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      rm -f "$tmp"
      fail "parameter $name: the last part must be a setting name in capitals"
    fi
    if ! [[ $value =~ $safe ]]; then
      rm -f "$tmp"
      fail "parameter $name: its value is empty or has a character the settings file cannot carry unchanged"
    fi
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
    count=$((count + 1))
  done <<<"$listing"
  if ! grep -q '^DATABASE_URL=' "$tmp"; then
    rm -f "$tmp"
    fail "parameter ${prefix}DATABASE_URL is missing"
  fi
  chmod 0600 "$tmp"
  mv -f "$tmp" "$API_ENV_FILE"
  log "wrote $count settings for the API"
}

container_of() {
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1"
}

stop_api() {
  local id
  id=$(container_of api)
  [ -n "$id" ] || return 0
  # shellcheck disable=SC2086  # one id per line, each its own argument
  docker stop --time 20 $id >/dev/null
  log 'stopped the API'
}

# The migrator's connection string goes to this one container, as a file in /run, which
# is memory, not disk, and which is removed as soon as the migrations end. It is in no
# environment and no argument: Docker keeps a container's environment in plain text on
# the data disk, which the nightly snapshots copy.
run_migrations() {
  local file="$RUN_DIR/tinnox-migrator-url" status=0
  rm -f "$file"
  (
    umask 077
    aws ssm get-parameter --name "$PARAMETERS/migrator/DATABASE_MIGRATOR_URL" \
      --with-decryption --query Parameter.Value --output text >"$file"
  ) || {
    rm -f "$file"
    fail "could not read the parameter $PARAMETERS/migrator/DATABASE_MIGRATOR_URL"
  }
  chown 10002:10002 "$file"
  chmod 0400 "$file"
  log 'running the migrations'
  docker run --rm --name tinnox-cms-migrate \
    --read-only --user 10002:10002 --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 128 --memory 512m \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --volume "$file:/run/secrets/migrator-url:ro" \
    --env DATABASE_MIGRATOR_URL_FILE=/run/secrets/migrator-url \
    "$RELEASE_IMAGE" || status=$?
  rm -f "$file"
  [ "$status" -eq 0 ] || fail "the migrations failed (exit $status)"
}

wait_until_ready() {
  local id attempt
  id=$(container_of api)
  [ -n "$id" ] || fail 'there is no API container after the start'
  for attempt in $(seq 1 30); do
    if docker exec "$id" node -e \
      "fetch('http://127.0.0.1:4000/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
      2>/dev/null; then
      log "the API is ready (attempt $attempt)"
      return 0
    fi
    sleep 2
  done
  fail 'the API did not become ready within a minute: see its log in CloudWatch'
}

tidy() {
  # Old release directories hold only the compose file and this script.
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | tail -n +$((KEEP_RELEASES + 1)) | cut -d' ' -f2- |
    while IFS= read -r old; do rm -rf -- "$old"; done
  # Images no container uses and that are more than a week old.
  docker image prune --all --force --filter until=168h >/dev/null || true
}

log "release of $TINNOX_TAG to $TINNOX_ENV begins"

for image in "$RELEASE_IMAGE" "$API_IMAGE" "$WEB_IMAGE" "$WORKER_IMAGE"; do
  docker pull --quiet "$image" >/dev/null
done
log 'pulled the images'

write_api_settings
stop_api
run_migrations

docker compose --project-name "$PROJECT" --file "$here/compose.yml" \
  up --detach --remove-orphans --wait --wait-timeout 240
log 'started the containers'

wait_until_ready
printf '%s %s\n' "$TINNOX_TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$RELEASES_DIR/current"
tidy
log "release of $TINNOX_TAG to $TINNOX_ENV finished"
