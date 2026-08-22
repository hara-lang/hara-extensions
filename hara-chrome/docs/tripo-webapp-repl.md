# Tripo Studio REPL map

`browser.site.tripo` binds Hara to the exact Tripo Studio tab opened by the
hara-chrome runtime. The initial adapter is deliberately read-only apart from
explicit navigation.

```clojure
(require [browser.site.tripo :as tripo])

(tripo/status)
(tripo/workspace)
(tripo/open-assets)
(tripo/assets)
(tripo/open-asset asset)
```

## Current product surface

The official Studio is hosted at `https://studio.tripo3d.ai`. Its current
public surface exposes a Studio workspace, an Assets library, and login from
the same application. Official Tripo material also describes personal and team
workspaces with isolated asset libraries, plus generation and refinement stages
for Generate, Overview, Segmentation, Retopology, Texture, Rigging, and
Stylization.

The adapter therefore separates capabilities into phases:

1. browser-controlled login and read-only inventory;
2. non-submitting generation drafts;
3. explicit credit-spending generation and visible task tracking;
4. visible model refinement;
5. explicit export and Greenways asset registration.

## Read-only snapshots

Current workspace:

```clojure
{:kind    :workspace
 :id      "personal"
 :name    "Personal Workspace"
 :mode    :personal
 :element {:tab-id 73 :backend-node-id 118}}
```

Visible asset:

```clojure
{:kind         :asset
 :id           "asset-chair"
 :title        "Wooden chair"
 :href         "/assets/wooden-chair"
 :status       :complete
 :visibility   :private
 :workspace-id "personal"
 :active?      false
 :element      {:tab-id 73 :backend-node-id 411}}
```

`open-asset` re-queries by `:id` and `:href` immediately before clicking. A
stale `:element` from an earlier inventory is never trusted as authority.

## Generation boundary

Text-to-3D, image-to-3D, segmentation, retopology, texturing, rigging,
stylization, and export are mapped but not implemented in the first slice.
Generation consumes account credits and may create externally visible assets,
so submission requires a separately reviewed command containing:

```clojure
{:workspace-id "personal"
 :confirm-credit-spend true
 :maximum-credits 100}
```

Draft operations may fill a prompt or select a reviewed local file, but they
must not click Generate. Private Tripo API requests are not the authority for
browser operations.

## Team boundary

Tripo Team provides shared workspaces, shared credits, member management, and
team asset visibility. The initial adapter may report the current workspace but
does not switch workspaces or mutate team membership, roles, visibility,
credits, subscriptions, or deletion settings.
