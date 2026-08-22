# Browser control examples

These examples run in the `ROOT` browser kernel after starting the development
runtime against a page:

```sh
make dev URL=https://example.test/application
```

They use the closed `browser.dom` surface for element discovery and ordinary
interaction, and `chrome.api` for fixed Chrome DevTools Protocol operations.
They deliberately do not use `Runtime.evaluate` or caller-supplied page
JavaScript.

## Common setup

```clojure
(ns examples.browser-control
  (:require [browser.dom :as dom]
            [chrome.api :as api]))

(def target
  (dom/target))

(def tab-id
  (get target :tab-id))

(api/attach tab-id)
```

`browser.dom` and `chrome.api` hold independent reference-counted debugger
leases. Releasing one does not tear down the other.

The following helper waits until an event of the requested CDP method arrives:

```clojure
(defn next-event
  [expected-method]
  (loop []
    (let [event (api/next-event tab-id)]
      (if (= expected-method (get event :method))
        event
        (recur)))))
```

Use narrow event subscriptions. A Fetch-domain request remains paused until it
is continued, failed, or fulfilled.

## Search and form pages

Find a search field, fill it, and submit:

```clojure
(def search-field
  (dom/query
   "input[type=search], input[name=q], input[name=query]"))

(when search-field
  (dom/focus search-field)
  (dom/fill search-field "Hara browser automation"))

(def submit-button
  (dom/query
   "button[type=submit], input[type=submit]"))

(when submit-button
  (dom/click submit-button))
```

Fill a simple contact form:

```clojure
(def email
  (dom/query "input[type=email]"))

(def message
  (dom/query "textarea[name=message]"))

(dom/fill email "developer@example.test")
(dom/fill message "Submitted through the headless Hara runtime")
(dom/click (dom/query "button[type=submit]"))
```

`dom/fill` supports inputs, textareas, selects, and content-editable elements.
It emits bubbling `input` and `change` events.

## Scroll an element into view

A DOM snapshot contains an opaque `:backend-node-id` that can be supplied to
CDP DOM operations:

```clojure
(def save-button
  (dom/query "#save"))

(api/send-command
 tab-id
 "DOM.scrollIntoViewIfNeeded"
 {:backendNodeId (get save-button :backend-node-id)})
```

For an infinite list, scroll the final currently loaded item into view and then
query the list again:

```clojure
(def rows
  (dom/query-all ".row, article, [role=listitem]" 500))

(def final-row
  (last rows))

(api/send-command
 tab-id
 "DOM.scrollIntoViewIfNeeded"
 {:backendNodeId (get final-row :backend-node-id)})

(def refreshed-rows
  (dom/query-all ".row, article, [role=listitem]" 500))

(count refreshed-rows)
```

Re-query after navigation or document replacement. Old element references
intentionally become stale.

## Mouse-wheel scrolling

Scroll down:

```clojure
(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mouseWheel"
  :x 600
  :y 500
  :deltaX 0
  :deltaY 800})
```

Scroll up:

```clojure
(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mouseWheel"
  :x 600
  :y 500
  :deltaX 0
  :deltaY -800})
```

Horizontal scrolling:

```clojure
(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mouseWheel"
  :x 600
  :y 500
  :deltaX 500
  :deltaY 0})
```

A feed-like page often responds more naturally to several smaller wheel
movements:

```clojure
(loop [remaining 5]
  (when (> remaining 0)
    (api/send-command
     tab-id
     "Input.dispatchMouseEvent"
     {:type "mouseWheel"
      :x 600
      :y 600
      :deltaX 0
      :deltaY 350})
    (recur (- remaining 1))))
```

## Pointer movement and coordinate clicks

Move the pointer:

```clojure
(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mouseMoved"
  :x 420
  :y 280})
```

Click a viewport coordinate:

```clojure
(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mousePressed"
  :x 420
  :y 280
  :button "left"
  :buttons 1
  :clickCount 1})

(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mouseReleased"
  :x 420
  :y 280
  :button "left"
  :buttons 0
  :clickCount 1})
```

Use `dom/click` for ordinary HTML elements. Coordinate input is most useful for
canvas, map, timeline, game, and diagram surfaces.

## Drag a custom surface

```clojure
(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mouseMoved"
  :x 200
  :y 300})

(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mousePressed"
  :x 200
  :y 300
  :button "left"
  :buttons 1
  :clickCount 1})

(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mouseMoved"
  :x 650
  :y 300
  :button "left"
  :buttons 1})

(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mouseReleased"
  :x 650
  :y 300
  :button "left"
  :buttons 0
  :clickCount 1})
```

## Calculate an element centre

Get the border quad for a DOM snapshot:

```clojure
(def card
  (dom/query ".card"))

(def box-response
  (api/send-command
   tab-id
   "DOM.getBoxModel"
   {:backendNodeId (get card :backend-node-id)}))

(def border
  (get (get box-response :model) :border))
```

The border is `[x1 y1 x2 y2 x3 y3 x4 y4]`. Calculate its centre:

```clojure
(def centre-x
  (/ (+ (nth border 0)
        (nth border 2)
        (nth border 4)
        (nth border 6))
     4))

(def centre-y
  (/ (+ (nth border 1)
        (nth border 3)
        (nth border 5)
        (nth border 7))
     4))
```

Move there to trigger a hover menu:

```clojure
(api/send-command
 tab-id
 "Input.dispatchMouseEvent"
 {:type "mouseMoved"
  :x centre-x
  :y centre-y})

(def menu-item
  (dom/query "[role=menuitem]"))

(when menu-item
  (dom/click menu-item))
```

## Observe network requests

Enable passive Network-domain observation:

```clojure
(api/send-command
 tab-id
 "Network.enable"
 {})

(dom/click (dom/query "#load-data"))

(def request-event
  (next-event "Network.requestWillBeSent"))

(def request
  (get (get request-event :params) :request))

{:method (get request :method)
 :url    (get request :url)}
```

Disable observation when finished:

```clojure
(api/send-command
 tab-id
 "Network.disable"
 {})
```

Treat headers, request bodies, and response bodies as potentially sensitive.
Do not print authentication material into a shared REPL transcript.

## Intercept and continue one API request

The Fetch domain pauses matching requests:

```clojure
(api/send-command
 tab-id
 "Fetch.enable"
 {:patterns
  [{:urlPattern "*://*/api/*"
    :requestStage "Request"}]})

(dom/click (dom/query "#refresh-data"))

(def paused
  (next-event "Fetch.requestPaused"))

(def paused-params
  (get paused :params))

(def intercepted-request
  (get paused-params :request))

{:method  (get intercepted-request :method)
 :url     (get intercepted-request :url)
 :headers (get intercepted-request :headers)}
```

Continue the request and disable interception:

```clojure
(api/send-command
 tab-id
 "Fetch.continueRequest"
 {:requestId (get paused-params :requestId)})

(api/send-command
 tab-id
 "Fetch.disable"
 {})
```

Keep patterns narrow and always resolve every paused request.

## Block a selected request

```clojure
(api/send-command
 tab-id
 "Fetch.enable"
 {:patterns
  [{:urlPattern "*://analytics.example.test/*"
    :requestStage "Request"}]})

(def paused
  (next-event "Fetch.requestPaused"))

(def paused-params
  (get paused :params))

(api/send-command
 tab-id
 "Fetch.failRequest"
 {:requestId (get paused-params :requestId)
  :errorReason "BlockedByClient"})

(api/send-command
 tab-id
 "Fetch.disable"
 {})
```

Use this only for a target and traffic that the developer is authorized to
control.

## Add request headers

```clojure
(api/send-command
 tab-id
 "Network.enable"
 {})

(api/send-command
 tab-id
 "Network.setExtraHTTPHeaders"
 {:headers
  {"X-Hara-Test" "headless-runtime"
   "X-Test-Scenario" "checkout"}})

(api/navigate tab-id "https://example.test/application")
```

Cleanup:

```clojure
(api/send-command
 tab-id
 "Network.disable"
 {})
```

## Fill a field and press Enter

```clojure
(def search
  (dom/query "input[type=search]"))

(dom/focus search)
(dom/fill search "portable Lisp")

(api/send-command
 tab-id
 "Input.dispatchKeyEvent"
 {:type "rawKeyDown"
  :key "Enter"
  :code "Enter"
  :windowsVirtualKeyCode 13})

(api/send-command
 tab-id
 "Input.dispatchKeyEvent"
 {:type "keyUp"
  :key "Enter"
  :code "Enter"
  :windowsVirtualKeyCode 13})
```

## Cleanup

Release the explicit low-level lease:

```clojure
(api/detach tab-id)
```

Release the closed DOM service lease:

```clojure
(dom/detach)
```

A later DOM operation attaches again automatically.

## Protocol references

- [CDP DOM domain](https://chromedevtools.github.io/devtools-protocol/tot/DOM/)
- [CDP Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
- [CDP Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- [CDP Fetch domain](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)
