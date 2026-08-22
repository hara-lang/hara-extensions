# Tripo Studio login sequence

The Tripo adapter checks login state before exposing private workspace and asset
inventories. Authentication remains browser-controlled: Hara does not receive
passwords, one-time codes, passkey responses, cookies, tokens, OAuth state, or
identity-provider page contents.

## Persistent headed login

```sh
make tripo-login
```

The default profile is:

```text
~/.greenways/hara-chrome/tripo-profile
```

The directory is created with owner-only permissions. Treat it as sensitive
browser state and never commit or package it.

Override it when needed:

```sh
make tripo-login TRIPO_PROFILE_DIR=/secure/path/tripo-profile
```

Connect the REPL and inspect the state:

```clojure
(require [browser.site.tripo :as tripo])

(tripo/login-status)
```

Possible states are:

- `:signed-in`
- `:signed-out`
- `:authentication-required`
- `:verification-required`
- `:external-authentication`
- `:loading`

Start the visible Studio login flow:

```clojure
(tripo/login-start)
```

Complete the account's normal sign-in or provider flow in the Chromium window,
then wait for the Studio inventory to return:

```clojure
(tripo/login-wait 600000)
```

The convenience operation combines both calls:

```clojure
(tripo/login 600000)
```

External provider pages are followed only by origin and pathname. Query strings
and fragments are removed from returned URLs, and provider page content is not
inspected.

After login, a headless runtime may reuse the profile:

```sh
make dev \
  PROFILE_DIR="$HOME/.greenways/hara-chrome/tripo-profile" \
  URL=https://studio.tripo3d.ai
```

Distinct failures include:

```text
tripo/login-ui-unsupported
tripo/login-action-unverified
tripo/login-transition-timeout
tripo/login-timeout
tripo/invalid-login-timeout
```

A timeout does not cancel the browser flow. Finish the visible challenge and
call `login-wait` again.
