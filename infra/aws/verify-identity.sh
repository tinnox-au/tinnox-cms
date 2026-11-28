#!/usr/bin/env bash
# Checks the sign-in of a deployed environment: the Cognito user pool, its app client,
# the API's settings and what the three of them answer over HTTPS. It is the deployed
# counterpart of `npm run verify:oidc`, which signs a test user in to the local Keycloak.
# A person runs it in AWS CloudShell, with their own rights:
#
#   infra/aws/verify-identity.sh test
#
# It changes nothing and signs nobody in. It reads the stacks' outputs, the pool and the
# client (cognito-idp Describe* calls), the API's settings in Parameter Store, and makes a
# handful of requests that need no account. It prints names and addresses, never a secret:
# the client's secret is only compared with the stored one.
#
# What it cannot show, because it has no session: the claims of a real token (auth_time,
# amr, acr) and a forced re-authentication. Those were confirmed by hand on 25 November
# 2026 (README.md, section 5) and need a real sign-in to confirm again.
#
# Exit 0 when every check passes, 1 when one fails, 64 on a usage error.
set -Eeuo pipefail
umask 077

environment=${1:-}
if ! [[ $environment =~ ^[a-z][a-z0-9]{1,11}$ ]] || [ "$#" -ne 1 ]; then
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi

readonly STACK="tinnox-cms-$environment"
readonly PARAMETERS="/tinnox-cms/$environment/api"

for tool in aws jq curl; do
  command -v "$tool" >/dev/null || {
    echo "FAILED: $tool is not installed (AWS CloudShell has it)" >&2
    exit 1
  }
done

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  failures=$((failures + 1))
}
# check <description> <actual> <expected>
check() {
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1 (found: ${2:-nothing}; expected: $3)"
  fi
}
section() { printf '\n%s\n' "$1"; }

output_of() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}
setting() {
  aws ssm get-parameter --name "$PARAMETERS/$1" --with-decryption \
    --query Parameter.Value --output text 2>/dev/null || true
}
# The status and Location of one GET, without following it: "<status> <location>".
answer() {
  curl --silent --max-time 20 --output /dev/null --write-out '%{http_code} %{redirect_url}' "$@"
}
# One query parameter of a URL, decoded.
parameter_of() {
  python3 -c '
import sys, urllib.parse
query = urllib.parse.parse_qs(urllib.parse.urlsplit(sys.argv[1]).query)
print(query.get(sys.argv[2], [""])[0])' "$1" "$2"
}
digest() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

portal=$(output_of "$STACK" PortalOrigin)
issuer=$(output_of "$STACK-identity" Issuer)
client_id=$(output_of "$STACK-identity" ClientId)
pool_id=$(output_of "$STACK-identity" UserPoolId)
pages=$(output_of "$STACK-identity" SignInPages)
readonly portal issuer client_id pool_id pages
readonly callback="$portal/api/auth/callback"
readonly signed_out="$portal/?state=signed_out"

printf 'Environment %s: pool %s, client %s, portal %s\n' "$environment" "$pool_id" "$client_id" "$portal"

# ---------------------------------------------------------------- what the pool publishes
section 'Discovery document'
discovery=$(curl --silent --fail --max-time 20 "$issuer/.well-known/openid-configuration")
check 'the issuer is the pool' "$(jq -r .issuer <<<"$discovery")" "$issuer"
check 'sign-in happens on the pool'"'"'s own pages' \
  "$(jq -r .authorization_endpoint <<<"$discovery")" "$pages/oauth2/authorize"
check 'codes are exchanged on the pool'"'"'s own pages' \
  "$(jq -r .token_endpoint <<<"$discovery")" "$pages/oauth2/token"
check 'PKCE with S256 is offered' \
  "$(jq -r '.code_challenge_methods_supported | index("S256") != null' <<<"$discovery")" true
check 'a sign-out address is published' \
  "$(jq -r .end_session_endpoint <<<"$discovery")" "$pages/logout"

# ---------------------------------------------------------------- the pool
section 'User pool'
pool=$(aws cognito-idp describe-user-pool --user-pool-id "$pool_id" --query UserPool --output json)
mfa=$(aws cognito-idp get-user-pool-mfa-config --user-pool-id "$pool_id" --output json)
check 'a second factor is required of everyone' "$(jq -r .MfaConfiguration <<<"$pool")" ON
check 'the second factor is an authenticator app' \
  "$(jq -r '.SoftwareTokenMfaConfiguration.Enabled // false' <<<"$mfa")" true
check 'a text message is not a second factor' \
  "$(jq -r '.SmsMfaConfiguration.SmsConfiguration // "none" | if . == "none" then "none" else "configured" end' <<<"$mfa")" none
check 'an e-mail code is not a second factor' \
  "$(jq -r '.EmailMfaConfiguration // "none" | if . == "none" then "none" else "configured" end' <<<"$mfa")" none
check 'only an administrator creates accounts' \
  "$(jq -r .AdminCreateUserConfig.AllowAdminCreateUserOnly <<<"$pool")" true
check 'people sign in with their e-mail address' \
  "$(jq -rc '.UsernameAttributes // []' <<<"$pool")" '["email"]'
check 'nobody recovers an account alone' \
  "$(jq -rc '[.AccountRecoverySetting.RecoveryMechanisms[]?.Name]' <<<"$pool")" '["admin_only"]'
check 'the pool cannot be deleted by accident' "$(jq -r .DeletionProtection <<<"$pool")" ACTIVE
check 'the pool is on the tier that reports the second factor' "$(jq -r .UserPoolTier <<<"$pool")" ESSENTIALS

# ---------------------------------------------------------------- the app client
section 'App client'
client=$(aws cognito-idp describe-user-pool-client --user-pool-id "$pool_id" --client-id "$client_id" \
  --query UserPoolClient --output json)
check 'the code flow and no other' "$(jq -rc '.AllowedOAuthFlows | sort' <<<"$client")" '["code"]'
check 'the scope "openid" and no other' "$(jq -rc '.AllowedOAuthScopes | sort' <<<"$client")" '["openid"]'
check 'one return address after sign-in' "$(jq -rc .CallbackURLs <<<"$client")" "[\"$callback\"]"
check 'the two return addresses after sign-out' \
  "$(jq -rc '.LogoutURLs | sort' <<<"$client")" "[\"$portal/\",\"$signed_out\"]"
check 'no sign-in through the Cognito API, only through the pages' \
  "$(jq -rc '.ExplicitAuthFlows | sort' <<<"$client")" '["ALLOW_REFRESH_TOKEN_AUTH"]'
check 'accounts of the pool itself only' \
  "$(jq -rc '.SupportedIdentityProviders | sort' <<<"$client")" '["COGNITO"]'
check 'the pages do not say whether an address has an account' \
  "$(jq -r .PreventUserExistenceErrors <<<"$client")" ENABLED
check 'a step of the sign-in pages lasts ten minutes at most' "$(jq -r .AuthSessionValidity <<<"$client")" 10
check 'an ID token lasts five minutes' \
  "$(jq -r '"\(.IdTokenValidity) \(.TokenValidityUnits.IdToken)"' <<<"$client")" '5 minutes'
check 'the client has a secret' "$(jq -r '(.ClientSecret // "") != ""' <<<"$client")" true

# ---------------------------------------------------------------- the API's settings
section 'API settings in Parameter Store'
check 'OIDC_ISSUER is the pool' "$(setting OIDC_ISSUER)" "$issuer"
check 'OIDC_CLIENT_ID is the client' "$(setting OIDC_CLIENT_ID)" "$client_id"
check 'OIDC_REDIRECT_URI is the registered return address' "$(setting OIDC_REDIRECT_URI)" "$callback"
check 'OIDC_POST_LOGOUT_REDIRECT_URI is the portal' "$(setting OIDC_POST_LOGOUT_REDIRECT_URI)" "$portal/"
check 'the stored client secret is the client'"'"'s' \
  "$(digest "$(setting OIDC_CLIENT_SECRET)")" "$(digest "$(jq -r .ClientSecret <<<"$client")")"
proof="$(setting OIDC_MFA_AMR_VALUES)$(setting OIDC_MFA_ACR_VALUES)"
check 'proof of the second factor is required' "$([ -n "$proof" ] && echo set || echo missing)" set

# ---------------------------------------------------------------- over HTTPS, no account
section 'What the API sends to start a sign-in'
read -r status location < <(answer "$portal/api/auth/login") || true
check 'the API redirects' "$status" 303
check 'to the pool'"'"'s sign-in address' "${location%%\?*}" "$pages/oauth2/authorize"
check 'as this client' "$(parameter_of "$location" client_id)" "$client_id"
check 'for a code' "$(parameter_of "$location" response_type)" code
check 'with the scope "openid" only' "$(parameter_of "$location" scope)" openid
check 'back to the registered address' "$(parameter_of "$location" redirect_uri)" "$callback"
check 'with PKCE S256' "$(parameter_of "$location" code_challenge_method)" S256
check 'with a state' "$([ -n "$(parameter_of "$location" state)" ] && echo yes || echo no)" yes
check 'with a nonce' "$([ -n "$(parameter_of "$location" nonce)" ] && echo yes || echo no)" yes

section 'What the pool answers without an account'
read -r status location < <(answer "$location") || true
check 'a sign-in the API started leads to the sign-in page, not to a code' \
  "$status ${location%%\?*}" "302 $pages/login"
read -r status location < <(answer "$pages/oauth2/authorize?client_id=$client_id&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcallback&state=x") || true
check 'a return address that is not registered gets no redirect to it' \
  "$(case "$location" in https://example.invalid*) echo redirected ;; *) echo refused ;; esac)" refused
read -r status location < <(answer "$pages/logout?client_id=$client_id&logout_uri=$(jq -rn --arg u "$signed_out" '$u | @uri')") || true
check 'sign-out returns to the portal with its marker' "$status $location" "302 $signed_out"
read -r status location < <(answer "$pages/logout?client_id=$client_id&logout_uri=https%3A%2F%2Fexample.invalid%2F") || true
check 'sign-out does not return to an address that is not registered' \
  "$(case "$location" in https://example.invalid*) echo redirected ;; *) echo refused ;; esac)" refused
# A secret that is wrong on purpose, made here so no secret-looking text is in this file.
wrong_pair="$client_id:$(printf 'wrong-%s' "$RANDOM$RANDOM")"
status=$(curl --silent --max-time 20 --output /dev/null --write-out '%{http_code}' \
  --user "$wrong_pair" --data 'grant_type=authorization_code&code=x' \
  --data-urlencode "redirect_uri=$callback" "$pages/oauth2/token")
check 'a code is not exchanged with a wrong client secret' \
  "$(case "$status" in 400 | 401) echo refused ;; *) echo "$status" ;; esac)" refused

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf '%s check(s) FAILED.\n' "$failures"
  exit 1
fi
printf 'All sign-in checks passed. Not covered: the claims of a real token and a forced re-authentication.\n'
