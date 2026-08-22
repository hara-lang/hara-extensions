# ChatGPT login sequence

The ChatGPT REPL adapter checks authentication before exposing chat and project
inventories. Authentication remains browser-controlled: Hara does not receive
passwords, one-time codes, cookies, access tokens, OAuth state, or provider page
contents. Credential and verification fields are detected with a count-only DOM
probe, so their input values are never mirrored into a snapshot.

## Start a persistent headed browser

Use a persistent browser profile so the completed session can be reused by
later headless runs:

```sh
make chatgpt-login
```

The default profile is:

```text
~/.greenways/hara-chrome/chatgpt-profile
```

The launcher creates that directory with owner-only permissions. Treat it as
sensitive browser state: do not commit, share, or copy it into ordinary build
artifacts.

Override it when needed:

```sh
make chatgpt-login CHATGPT_PROFILE_DIR=/secure/path/chatgpt-profile
```

Once the runtime prints its RESP address, connect the REPL and inspect state:

```clojure
(require [browser.site.chatgpt :as chatgpt])

(chatgpt/login-status)
```

Possible states include:

- `:signed-in`
- `:signed-out`
- `:authentication-required`
- `:verification-required`
- `:external-authentication`
- `:loading`

## User-controlled sequence

Start the visible login flow:

```clojure
(chatgpt/login-start)
```

Complete the account's normal sign-in method in the Chromium window. The
adapter does not choose a provider or fill credential and verification fields.
After completing the browser flow:

```clojure
(chatgpt/login-wait 600000)
```

A convenience operation starts and waits in one call:

```clojure
(chatgpt/login 600000)
```

The wait follows the same tab through ChatGPT and external identity-provider
origins, but it does not inspect external pages. Returned URLs omit query and
fragment data so OAuth state and authorization codes do not cross into the
REPL transcript.

After a successful persistent-profile login, a headless runtime can reuse the
same session:

```sh
make dev \
  PROFILE_DIR="$HOME/.greenways/hara-chrome/chatgpt-profile" \
  URL=https://chatgpt.com
```

## Failure behavior

The sequence fails closed for ambiguous or missing login controls and uses
distinct errors including:

```text
chatgpt/login-ui-unsupported
chatgpt/login-action-unverified
chatgpt/login-transition-timeout
chatgpt/login-timeout
chatgpt/invalid-login-timeout
```

A timeout does not cancel or mutate the browser's authentication flow. The user
can inspect `login-status`, finish the browser challenge, and call `login-wait`
again.
