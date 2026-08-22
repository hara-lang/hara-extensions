# Download Tripo assets

Tripo Studio exports models through its visible asset page. Available formats
can vary by model workflow and account plan, so the Hara adapter discovers the
currently visible choices instead of assuming every format is enabled.

The initial download surface supports visible choices including GLB, glTF, FBX,
OBJ, STL, USD, USDZ, and 3MF. Tripo's current documentation describes GLB and
FBX for rigged assets, GLB/OBJ/FBX/STL for Smart Mesh, and the broader export
family USD, FBX, OBJ, STL, GLB, and 3MF:

- https://www.tripo3d.ai/blog/tripo-studio-tutorial-english
- https://www.tripo3d.ai/blog/smart-mesh-tutorial
- https://www.tripo3d.ai/tutorials/tripo-ai-export-formats
- https://www.tripo3d.ai/pricing

## Open the asset

Start the persistent Tripo runtime and connect the REPL:

```sh
make tripo-login
```

```clojure
(require [browser.site.tripo :as tripo])

(def chair
  (first (tripo/assets)))

(tripo/open-asset chair)
```

The requested asset must be the active visible asset before export. This makes
export an explicit operation and prevents an old snapshot from downloading a
different model after navigation.

## Inspect visible formats

```clojure
(tripo/export-options chair)
```

A result resembles:

```clojure
[{:kind       :export-option
  :format     "glb"
  :label      "GLB"
  :available? true
  :selected?  false
  :note       nil
  :element    {:tab-id 73 :backend-node-id 441}}

 {:kind       :export-option
  :format     "fbx"
  :label      "FBX"
  :available? false
  :selected?  false
  :note       "Upgrade required"
  :element    {:tab-id 73 :backend-node-id 442}}]
```

The adapter opens Tripo's visible export surface and reads its current options.
A disabled or plan-limited choice remains visible in the inventory but cannot be
downloaded.

## Download through the visible UI

```clojure
(tripo/download-asset
 chair
 {:format :glb
  :directory "Greenways/Tripo"
  :name "Wooden chair"
  :confirm-download? true
  :timeout-ms 120000})
```

`:directory` is relative to the browser's Downloads directory. Absolute paths,
empty paths, and `..` path components are rejected. Existing filenames use
Chrome's `uniquify` behavior rather than overwriting a file.

The page initiates the actual download by clicking its visible Download control.
The extension does **not** replay a signed CDN URL. It arms a single download
capture, associates the next exact tab-bound download with the export action,
suggests the relative filename, waits for Chrome to report completion, and then
returns a receipt:

```clojure
{:kind          :asset-download
 :protocol      "greenways.browser-download/0-alpha"
 :asset-id      "asset-chair"
 :workspace-id  "personal"
 :format        "glb"
 :id            287
 :state         "complete"
 :relative-path "Greenways/Tripo/Wooden-chair.glb"
 :path          "/Users/me/Downloads/Greenways/Tripo/Wooden-chair.glb"
 :mime          "model/gltf-binary"
 :bytes         1832412
 :danger        "safe"
 :exists?       true
 :started-at    "2026-08-18T03:12:10.000Z"
 :ended-at      "2026-08-18T03:12:14.000Z"
 :source        {:origin "https://cdn.tripo3d.ai"
                 :pathname "/asset.glb"}}
```

Query strings and fragments are removed from `:source`; temporary signatures do
not enter the REPL transcript. File bytes do not cross into Hara.

## Safety and authority

A download requires all of the following:

- an exact asset `:id` and `:href`;
- that same asset open in the bound Tripo Studio tab;
- a visible available format;
- an explicit relative Downloads directory;
- `:confirm-download? true`;
- a visible final Download control;
- successful Chrome completion and metadata readback.

The adapter never calls `chrome.downloads.download`, never accepts a dangerous
file classification, never captures cookies or authorization headers, and never
uses Tripo's private API as authority. A timeout stops waiting but does not cancel
or mutate a browser download already in progress.

Downloads are local artifacts, not published Greenways assets. Exact-byte
hashing, provenance, and registration should be performed by the reviewed
Downloads-folder importer tracked under the Greenways asset registry work.
