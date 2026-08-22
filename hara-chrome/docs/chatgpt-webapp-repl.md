# ChatGPT web-app REPL map

This document maps a possible `browser.site.chatgpt` adapter built on
`browser.dom`. It is a design and discovery contract, not a promise that the
current ChatGPT DOM will retain a particular selector.

The adapter controls only the user's already authenticated, panel-bound browser
tab. It must not scrape credentials, call undocumented private endpoints,
inject content scripts, or add caller-supplied page JavaScript.

## Current product concepts

The following product concepts are documented by OpenAI as of 2026-08-17:

- Projects group chats, files, project instructions, and related context in one
  workspace. Existing chats can be moved into a project; pinned chats can also
  be moved when the action is available.
- Project chats can be found with chat search, and projects may be shared on
  supported accounts.
- Pinned chats appear at the top of the chat list. On web, the user pins a chat
  from its sidebar overflow menu.
- Global chat search is available from the sidebar or with `Ctrl+K`/`Cmd+K`,
  and currently searches exact terms in chat titles and content.
- Chats can be archived or deleted from their overflow menu. Delete is
  destructive and cannot be undone.

Official references:

- [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- [Pinned chats release note](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- [Search chat history](https://help.openai.com/en/articles/10056348-how-do-i-search-my-chat-history-in-chatgpt)
- [Delete and archive chats](https://help.openai.com/en/articles/8809935-how-to-delete-and-archive-chats-in-chatgpt)

## Proposed Hara surface

```clojure
(require [browser.site.chatgpt :as chatgpt])

(chatgpt/status)
(chatgpt/chats)
(chatgpt/pinned)
(chatgpt/projects)
(chatgpt/search-chats "runtime design")
(chatgpt/open-chat chat)
(chatgpt/open-project project)
(chatgpt/project-chats project)

(chatgpt/new-chat)
(chatgpt/fill-composer "Summarise the current project")
(chatgpt/send)

(chatgpt/pin chat {:confirm true})
(chatgpt/unpin chat {:confirm true})
(chatgpt/move-to-project chat project {:confirm true})
(chatgpt/archive chat {:confirm true})
```

Deletion should require a stronger token tied to the selected chat:

```clojure
(chatgpt/delete-chat
 chat
 {:confirm-title (get chat :title)
  :confirm-id    (get chat :id)})
```

The first implementation should be read-only and navigational. Mutations should
be added only after stable discovery and menu handling have hermetic tests.

## Entity snapshots

Chats:

```clojure
{:kind       :chat
 :id         "ui-derived-stable-id-or-href"
 :title      "Headless Hara DOM Access"
 :href       "/c/..."
 :pinned?    true
 :project-id nil
 :active?    false
 :element    {:tab-id ...
              :backend-node-id ...}}
```

Projects:

```clojure
{:kind    :project
 :id      "ui-derived-stable-id-or-href"
 :title   "GW Opensource"
 :href    "..."
 :active? false
 :element {:tab-id ...
           :backend-node-id ...}}
```

Search results:

```clojure
{:kind    :chat-search-result
 :chat-id "..."
 :title   "..."
 :snippet "..."
 :element {:tab-id ...
           :backend-node-id ...}}
```

Element snapshots are short-lived. Adapters should retain the logical identity
and re-query before acting.

## Capability matrix

| Capability | Initial support | Risk | Confirmation |
| --- | --- | --- | --- |
| Detect signed-in ChatGPT page | yes | read | none |
| List visible chats | yes | read | none |
| List pinned chats | yes | read | none |
| List projects | yes | read | none |
| Open a chat | yes | navigation | none |
| Open a project | yes | navigation | none |
| Search chats | yes | reversible UI | none |
| List chats in an open project | yes | read | none |
| Start a new chat | phase 2 | write | explicit command |
| Fill composer | phase 2 | local UI | explicit text argument |
| Send message | phase 2 | externally visible write | explicit command |
| Pin or unpin chat | phase 3 | reversible write | `{:confirm true}` |
| Move chat to project | phase 3 | reversible write | `{:confirm true}` |
| Archive chat | phase 3 | reversible write | `{:confirm true}` |
| Rename chat or project | phase 3 | reversible write | expected old and new title |
| Create project | phase 4 | write | explicit command |
| Update project instructions | phase 4 | write | expected project ID |
| Add project source or file | phase 4 | data upload | explicit file/source |
| Share project | deferred | access-control write | separate authority |
| Delete chat or project | deferred | destructive | matching title and ID |

## Discovery strategy

The adapter must discover capabilities rather than assume one permanent DOM
shape.

1. Confirm that the bound target is an expected ChatGPT origin.
2. Find the sidebar using landmark roles and accessible names.
3. Identify chat and project candidates from semantic links, visible labels,
   and stable hrefs.
4. Detect pinned state from a visible pinned section, icon label, or the
   overflow menu state.
5. Record a selector-profile fingerprint.
6. Fail closed with `chatgpt/ui-unsupported` when required landmarks are
   missing or ambiguous.

Preferred selector order:

1. ARIA role plus accessible name.
2. Native element and stable href.
3. Visible text within an already identified region.
4. Stable `data-testid`, when present.
5. Never hashed CSS-module or generated utility class names.

Route fragments can help disambiguate a candidate, but they are not the source
authority and must not be the only test.

## Proposed selector profile

A selector profile is data rather than scattered constants:

```clojure
{:version 1
 :target-origins ["https://chatgpt.com"]
 :sidebar
 {:landmarks
  [{:selector "nav" :score 10}
   {:selector "[role=navigation]" :score 8}]}
 :chat
 {:link-candidates ["nav a" "[role=navigation] a"]
  :menu-labels ["More" "Chat options"]}
 :project
 {:region-labels ["Projects"]
  :link-candidates ["nav a" "[role=navigation] a"]}
 :search
 {:button-labels ["Search"]
  :keyboard-shortcuts ["Meta+k" "Control+k"]}
 :composer
 {:candidates
  ["textarea"
   "[contenteditable=true][role=textbox]"]}
 :actions
 {:pin ["Pin chat"]
  :unpin ["Unpin chat"]
  :move ["Move to project"]
  :archive ["Archive"]
  :delete ["Delete"]}}
```

Localized labels require an explicit locale profile. The adapter should not
guess destructive menu actions by position.

## Read-only discovery sketch

The core module already supplies the primitives required to prototype
discovery:

```clojure
(require [browser.dom :as dom])

(def navigation-links
  (dom/query-all "nav a, [role=navigation] a" 500))

(def projects-heading
  (dom/query
   "nav [aria-label*=Project], [role=navigation] [aria-label*=Project]"))

(def search-control
  (dom/query
   "button[aria-label*=Search], [role=button][aria-label*=Search]"))
```

These are probes, not a final selector contract. A real adapter should score
several signals and reject ambiguity.

## Interaction state machine

```text
:detached
  -> :target-verified
  -> :sidebar-discovered
  -> :inventory-ready
  -> :chat-open | :project-open | :search-open
  -> :composer-ready
  -> :mutation-pending
  -> :mutation-verified
```

Each transition rechecks the target URL and refreshes stale references.
Navigation invalidation returns to `:target-verified`.

## Mutation verification

A write operation is not complete when a click succeeds. It is complete only
after the visible UI confirms the intended state.

Examples:

- `pin`: chat appears in the pinned inventory.
- `unpin`: chat disappears from pinned inventory but remains in chats.
- `move-to-project`: chat appears inside the expected project.
- `archive`: chat disappears from active history.
- `send`: a new user message with the submitted text is visible.
- `rename`: title changes from the expected old value to the expected new value.

If verification fails, return `chatgpt/action-unverified` with the before and
after inventories.

## Network boundary

The generic examples demonstrate Network and Fetch interception for controlled
test pages. The ChatGPT adapter should not depend on, replay, or mutate
undocumented ChatGPT backend requests.

Optional diagnostic observation must:

- be explicitly enabled;
- redact authorization, cookie, account, and workspace headers;
- avoid request or response bodies by default;
- never write captured data into normal chat logs;
- disable itself before returning control to the user.

The supported adapter contract is the visible UI, not a private web API.

## Test fixtures

Use a local hermetic fixture with several layout profiles:

- compact and expanded sidebar;
- empty, short, and long chat lists;
- pinned and unpinned chats;
- personal and shared projects;
- duplicate chat titles;
- localized action labels;
- stale element references after navigation;
- menu dismissal and delayed rendering;
- destructive confirmation dialogs.

Live ChatGPT smoke tests should be opt-in, read-only by default, and operate on
a dedicated test account or disposable test content.

## Delivery phases

### Phase 1 — inventory

Implement:

```clojure
status
chats
pinned
projects
open-chat
open-project
search-chats
project-chats
```

### Phase 2 — composer

Implement:

```clojure
new-chat
fill-composer
send
stop
```

### Phase 3 — reversible organization

Implement:

```clojure
pin
unpin
move-to-project
archive
rename-chat
rename-project
```

### Phase 4 — project management

Implement project creation, instructions, sources, and files with explicit
authority records.

### Deferred

Sharing, membership changes, bulk archive/delete, and destructive deletion
remain outside the first adapter.
