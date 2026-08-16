;;; hara-mode-test.el --- Tests for hara-mode -*- lexical-binding: t; -*-

(require 'ert)
(require 'hara-mode)

(ert-deftest hara-resp-parses-fragmented-values ()
  (should-error (hara--resp-parse-at (encode-coding-string "$5\r\nhe" 'raw-text t) 0)
                :type 'hara-resp-incomplete)
  (should (equal (hara--resp-parse-at
                  (encode-coding-string "$5\r\nhello\r\n" 'raw-text t) 0)
                 '("hello" . 11))))

(ert-deftest hara-resp-parses-nested-and-concatenated-frames ()
  (let* ((data (encode-coding-string
                "*3\r\n$6\r\nRESULT\r\n$1\r\n1\r\n*2\r\n:2\r\n$2\r\nok\r\n+NEXT\r\n"
                'raw-text t))
         (first (hara--resp-parse-at data 0))
         (second (hara--resp-parse-at data (cdr first))))
    (should (equal (car first) '("RESULT" "1" (2 "ok"))))
    (should (equal (car second) "NEXT"))
    (should (= (cdr second) (length data)))))

(ert-deftest hara-resp-encodes-utf8-by-byte-length ()
  (let ((encoded (hara--resp-encode-value "hé")))
    (should (equal encoded
                   (concat "$3\r\n"
                           (encode-coding-string "hé" 'utf-8 t)
                           "\r\n")))))

(ert-deftest hara-protocol-version-accepts-truffle-and-rust-metadata ()
  (should (= 4 (hara--protocol-version '(("PROTO" . 4)))))
  (should (= 4 (hara--protocol-version '(("PROTOCOL" . "4"))))))

(ert-deftest hara-frame-routing-waits-for-done ()
  (let* ((connection
          (hara--make-connection
           :pending (make-hash-table :test #'equal)))
         result)
    (puthash "R1" (list :success (lambda (value) (setq result value)))
             (hara-connection-pending connection))
    (let ((process (make-pipe-process :name "hara-test-process"
                                      :command '("cat") :noquery t)))
      (unwind-protect
          (progn
            (process-put process 'hara-negotiated t)
            (process-put process 'hara-connection connection)
            (hara--handle-frame process '("RESULT" "R1" "42"))
            (should-not result)
            (hara--handle-frame process '("DONE" "R1" "OK"))
            (should (equal result "42"))
            (should-not (gethash "R1" (hara-connection-pending connection))))
        (delete-process process)))))

(ert-deftest hara-server-filter-detects-fragmented-endpoint ()
  (let* ((buffer (generate-new-buffer " *hara-server-filter-test*"))
         (process (make-pipe-process :name "hara-server-filter-test"
                                     :buffer buffer :command '("cat")
                                     :noquery t)))
    (unwind-protect
        (progn
          (hara--server-process-filter process "HARA RE")
          (should-not (process-get process 'hara-endpoint))
          (hara--server-process-filter process "SP 127.0.0.1:4567\n")
          (should (equal (process-get process 'hara-endpoint)
                         '("127.0.0.1" . 4567))))
      (delete-process process)
      (kill-buffer buffer))))

(ert-deftest hara-project-and-cache-are-keyed-by-canonical-root ()
  (let* ((root (make-temp-file "hara-project-" t))
         (nested (expand-file-name "src/deep" root))
         (hara-cache-directory (make-temp-file "hara-cache-" t)))
    (unwind-protect
        (progn
          (make-directory nested t)
          (with-temp-file (expand-file-name "project.edn" root)
            (insert "{:hara/type :project :project/id test}"))
          (let ((default-directory nested))
            (should (equal (hara--project-root)
                           (file-name-as-directory (file-truename root)))))
          (let ((connection
                 (hara--make-connection
                  :root (file-name-as-directory (file-truename root))
                  :host "127.0.0.1" :port 1234 :instance "abc"
                  :project (file-name-as-directory (file-truename root)))))
            (hara--write-cache connection)
            (should (equal (plist-get
                            (hara--read-cache (hara-connection-root connection))
                            :instance)
                           "abc"))
            (hara--delete-cache (hara-connection-root connection))
            (should-not (hara--read-cache (hara-connection-root connection)))))
      (delete-directory root t)
      (delete-directory hara-cache-directory t))))

(ert-deftest hara-resolve-command-finds-workspace-launcher ()
  (let* ((root (make-temp-file "hara-workspace-" t))
         (project (expand-file-name "technology/hara/core/lib" root))
         (launcher (expand-file-name "extensions/hara-emacs/bin/hara" root))
         (hara-command "hara"))
    (unwind-protect
        (progn
          (make-directory project t)
          (make-directory (file-name-directory launcher) t)
          (with-temp-file launcher (insert "#!/bin/sh\n"))
          (set-file-modes launcher #o755)
          (cl-letf (((symbol-function 'hara--project-file-root)
                     (lambda () project)))
            (should (equal (hara--resolve-command) launcher))))
      (delete-directory root t))))

(ert-deftest hara-mode-auto-jacks-in-only-for-project-files ()
  (let* ((root (make-temp-file "hara-auto-project-" t))
         (standalone-root (make-temp-file "hara-standalone-" t))
         (source-directory (expand-file-name "src" root))
         (source-file (expand-file-name "sample.hal" source-directory))
         jack-in-called)
    (unwind-protect
        (progn
          (make-directory source-directory)
          (with-temp-file (expand-file-name "project.edn" root)
            (insert "{:hara/type :project :project/id auto}"))
          (with-temp-buffer
            (setq-local buffer-file-name source-file)
            (cl-letf (((symbol-function 'run-at-time)
                       (lambda (_seconds _repeat function &rest arguments)
                         (apply function arguments)
                         'fake-timer))
                      ((symbol-function 'hara-jack-in)
                       (lambda () (setq jack-in-called t))))
              (hara-mode)
              (should jack-in-called)
              (should (equal (hara--project-file-root)
                             (file-name-as-directory (file-truename root))))))
          (setq jack-in-called nil)
          (with-temp-buffer
            (setq-local buffer-file-name
                        (expand-file-name "standalone.hal"
                                          standalone-root))
            (cl-letf (((symbol-function 'hara-jack-in)
                       (lambda () (setq jack-in-called t))))
              (hara-mode)
              (should-not jack-in-called))))
      (delete-directory root t)
      (delete-directory standalone-root t))))

(ert-deftest hara-project-discovery-ignores-project-hal ()
  (let* ((root (make-temp-file "hara-project-hal-" t))
         (source (expand-file-name "src/tool/project.hal" root)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory source) t)
          (with-temp-file source (insert "(ns tool.project)"))
          (with-temp-buffer
            (setq-local buffer-file-name source)
            (should-not (hara--project-file-root))))
      (delete-directory root t))))

(ert-deftest hara-test-command-uses-project-edn-and-current-file ()
  (let* ((root (make-temp-file "hara-test-project-" t))
         (source (expand-file-name "test/sample_test.hal" root)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory source) t)
          (with-temp-file (expand-file-name "project.edn" root) (insert "{}"))
          (with-temp-file source (insert "(ns sample-test)"))
          (with-temp-buffer
            (setq-local buffer-file-name source)
            (let ((hara-command "/usr/local/bin/hara"))
              (cl-letf (((symbol-function 'hara--resolve-command)
                         (lambda () hara-command)))
                (should (equal
                         (hara--test-command source)
                         (mapconcat
                          #'shell-quote-argument
                          (list hara-command "--project"
                                (file-name-as-directory (file-truename root))
                                "--offline" "project" "test" source)
                          " ")))))))
      (delete-directory root t))))

(ert-deftest hara-manage-compatibility-commands-use-preview-workflow ()
  (should (eq (symbol-function 'hara-import) 'hara-manage-import))
  (should (eq (symbol-function 'hara-scaffold) 'hara-manage-scaffold))
  (should (eq (symbol-function 'hara-purge) 'hara-manage-purge)))

(ert-deftest hara-start-server-loads-the-owning-project ()
  (let ((root "/tmp/hara-project/")
        captured-command
        captured-filter)
    (cl-letf (((symbol-function 'hara--resolve-command) (lambda () "hara"))
              ((symbol-function 'get-buffer-create) (lambda (&rest _) (current-buffer)))
              ((symbol-function 'erase-buffer) #'ignore)
              ((symbol-function 'make-process)
               (lambda (&rest arguments)
                 (setq captured-command (plist-get arguments :command)
                       captured-filter (plist-get arguments :filter))
                 'fake-process))
              ((symbol-function 'process-get)
               (lambda (_process property)
                 (and (eq property 'hara-endpoint) '("127.0.0.1" . 1311))))
              ((symbol-function 'hara--open-endpoint)
               (lambda (&rest _) 'connection)))
      (should (eq (hara--start-server root) 'connection))
      (should (equal captured-command
                     '("hara" "--project" "/tmp/hara-project/"
                       "--root" "/tmp/hara-project/"
                       "--host" "127.0.0.1" "--port" "0" "headless")))
      (should (eq captured-filter #'hara--server-process-filter)))))

(ert-deftest hara-mode-installs-built-in-editing-hooks ()
  (with-temp-buffer
    (hara-mode)
    (should (eq major-mode 'hara-mode))
    (should (member #'hara-completion-at-point completion-at-point-functions))
    (should (member #'hara-eldoc-function eldoc-documentation-functions))
    (should (member #'hara--xref-backend xref-backend-functions))
    (insert "(defn answer []\n  42) ; comment")
    (font-lock-ensure)
    (should (eq (get-text-property 2 'face) 'font-lock-keyword-face))))

(ert-deftest hara-mode-highlights-private-definitions ()
  (with-temp-buffer
    (hara-mode)
    (insert "(def- private-value 42)\n(defn- private-function [] private-value)")
    (font-lock-ensure)
    (goto-char (point-min))
    (dolist (definition '("def-" "defn-"))
      (search-forward definition)
      (should (eq (get-text-property (match-beginning 0) 'face)
                  'font-lock-keyword-face)))
    (goto-char (point-min))
    (search-forward "private-value")
    (should (eq (get-text-property (match-beginning 0) 'face)
                'font-lock-variable-name-face))
    (search-forward "private-function")
    (should (eq (get-text-property (match-beginning 0) 'face)
                'font-lock-function-name-face))))

(ert-deftest hara-mode-highlights-semantic-categories ()
  (with-temp-buffer
    (hara-mode)
    (insert "(def answer true)\n"
            "(declare later)\n"
            "(defn add [x] x)\n"
            "(defprotocol Lookup)\n"
            "(defrecord Entry [])\n"
            "(when-let [value :sample/key] *dynamic*)")
    (font-lock-ensure)
    (dolist (entry '(("answer" . font-lock-variable-name-face)
                     ("later" . font-lock-variable-name-face)
                     ("add" . font-lock-function-name-face)
                     ("Lookup" . font-lock-type-face)
                     ("Entry" . font-lock-type-face)
                     ("when-let" . font-lock-keyword-face)
                     ("true" . font-lock-constant-face)
                     (":sample/key" . font-lock-constant-face)
                     ("*dynamic*" . font-lock-variable-name-face)))
      (goto-char (point-min))
      (search-forward (car entry))
      (should (eq (get-text-property (match-beginning 0) 'face) (cdr entry))))))

(ert-deftest hara-mode-does-not-highlight-forms-in-comments-or-strings ()
  (with-temp-buffer
    (hara-mode)
    (insert "; defn :comment\n\"defrecord :string\"")
    (font-lock-ensure)
    (goto-char (point-min))
    (search-forward "defn")
    (should-not (eq (get-text-property (match-beginning 0) 'face)
                    'font-lock-keyword-face))
    (search-forward "defrecord")
    (should-not (eq (get-text-property (match-beginning 0) 'face)
                    'font-lock-keyword-face))))

(ert-deftest hara-structured-doc-formatting ()
  (let ((value '("SYMBOL" "sample/add"
                 "DOC" "Adds values.\nMore detail."
                 "ARGLISTS" (("left" "right") ("values"))
                 "FILE" "/tmp/sample.hal"
                 "LINE" 7
                 "COLUMN" 3)))
    (should (equal (hara--doc-get value "DOC") "Adds values.\nMore detail."))
    (should (equal (hara--format-signatures value)
                   "sample/add [left right]  sample/add [values]"))))

(ert-deftest hara-eldoc-stays-silent-while-disconnected ()
  (with-temp-buffer
    (hara-mode)
    (insert "sample/add")
    (let (called)
      (should-not (hara-eldoc-function (lambda (&rest _) (setq called t))))
      (should-not called))))

(ert-deftest hara-completion-failure-falls-back-without-breaking-company ()
  (with-temp-buffer
    (hara-mode)
    (insert "neg")
    (let* ((process (make-pipe-process :name "hara-capf-test"
                                       :command '("cat") :noquery t))
           (hara--connection
            (hara--make-connection :process process
                                   :pending (make-hash-table :test #'equal))))
      (unwind-protect
          (cl-letf (((symbol-function 'hara--request-sync)
                     (lambda (&rest _)
                       (error "stale runtime"))))
            (let ((completion (hara-completion-at-point)))
              (should completion)
              (should-not (nth 2 completion))))
        (delete-process process)))))

(ert-deftest hara-completion-normalizes-runtime-responses-and-static-forms ()
  (should (equal (hara--completion-candidates "mapv\nmap\nmapv" "ma")
                 '("map" "mapv")))
  (should (equal (hara--completion-candidates '("when-let" "when") "when")
                 '("when" "when-let" "when-not"))))

(ert-deftest hara-completion-works-offline-and-skips-comments-and-strings ()
  (with-temp-buffer
    (hara-mode)
    (insert "defn-")
    (let ((completion (hara-completion-at-point)))
      (should (equal (nth 2 completion) '("defn-"))))
    (erase-buffer)
    (insert "; def")
    (should-not (hara-completion-at-point))
    (erase-buffer)
    (insert "\"def\"")
    (backward-char)
    (should-not (hara-completion-at-point))))

(ert-deftest hara-documentation-is-cached-and-invalidated ()
  (let* ((process (make-pipe-process :name "hara-doc-cache-test"
                                     :command '("cat") :noquery t))
         (connection
          (hara--make-connection :process process
                                 :pending (make-hash-table :test #'equal)
                                 :doc-cache (make-hash-table :test #'equal)))
         (response '("SYMBOL" "add" "DOC" "Adds." "ARGLISTS" (("x"))))
         (requests 0))
    (unwind-protect
        (cl-letf (((symbol-function 'hara--connection) (lambda () connection))
                  ((symbol-function 'hara--request)
                   (lambda (_connection _operation _arguments success &optional _failure)
                     (cl-incf requests)
                     (funcall success response))))
          (hara--request-doc "add" #'ignore)
          (hara--request-doc "add" #'ignore)
          (should (= requests 1))
          (hara--invalidate-doc-cache connection)
          (hara--request-doc "add" #'ignore)
          (should (= requests 2)))
      (delete-process process))))

(ert-deftest hara-inline-result-appears-after-form-and-clears-on-edit ()
  (with-temp-buffer
    (let ((hara-inline-result-duration nil))
      (hara-mode)
      (insert "(+ 1 2)")
      (let ((marker (copy-marker (point) t)))
        (hara--display-inline marker "3" 'hara-inline-result-face)
        (should (overlayp hara--result-overlay))
        (should (string-match-p "=> 3"
                                (overlay-get hara--result-overlay 'after-string)))
        (insert " ")
        (should-not hara--result-overlay)))))

(ert-deftest hara-inline-result-clears-after-next-command ()
  (with-temp-buffer
    (let ((hara-inline-result-duration nil))
      (hara-mode)
      (insert "(+ 1 2)")
      (hara--display-inline (copy-marker (point) t) "3" 'hara-inline-result-face)
      (should (overlayp hara--result-overlay))
      (run-hooks 'post-command-hook)
      (should-not hara--result-overlay))))

(ert-deftest hara-imenu-indexes-definitions ()
  (with-temp-buffer
    (hara-mode)
    (insert "(def answer 42)\n(defn add [x y] (+ x y))")
    (let* ((index (imenu--make-index-alist t))
           (definitions (cdr (assoc "Definitions" index))))
      (should (assoc "answer" definitions))
      (should (assoc "add" definitions)))))

(ert-deftest hara-eval-source-arguments-carry-location ()
  (with-temp-buffer
    (setq-local buffer-file-name "/tmp/sample.hal")
    (insert "\n  (+ 1 2)")
    (let ((arguments (hara--source-arguments "(+ 1 2)" 4)))
      (should (equal arguments
                     (list "(+ 1 2)" "FILE" (file-truename "/tmp/sample.hal")
                           "LINE" "2" "COLUMN" "3"))))))

(ert-deftest hara-xref-builds-source-location-from-doc-response ()
  (let ((hara--connection
         (hara--make-connection :root "/tmp/" :pending (make-hash-table))))
    (cl-letf (((symbol-function 'hara--connection)
               (lambda () hara--connection))
              ((symbol-function 'hara--request-sync)
               (lambda (&rest _)
                 '("SYMBOL" "sample/add"
                   "DOC" nil
                   "ARGLISTS" (("x" "y"))
                   "FILE" "/tmp/sample.hal"
                   "LINE" 12
                   "COLUMN" 3))))
      (let* ((xref (car (xref-backend-definitions 'hara "sample/add")))
             (location (xref-item-location xref)))
        (should (equal (xref-file-location-file location) "/tmp/sample.hal"))
        (should (= (xref-file-location-line location) 12))
        (should (= (xref-file-location-column location) 2))))))

(ert-deftest hara-xref-prefers-local-hara-source ()
  (let* ((root (make-temp-file "hara-xref-project-" t))
         (file (expand-file-name "lib/src/code/manage.hal" root))
         requested)
    (unwind-protect
        (progn
          (make-directory (file-name-directory file) t)
          (with-temp-file (expand-file-name "project.edn" root) (insert "{}"))
          (with-temp-file file
            (insert "(ns code.manage)\n\n(defn scaffold\n  [input]\n  input)\n"))
          (with-temp-buffer
            (setq default-directory root)
            (insert "(ns demo.core)\n(code.manage/scaffold input)\n")
            (cl-letf (((symbol-function 'hara--request-doc-sync)
                       (lambda (&rest _) (setq requested t))))
              (let* ((xref (car (xref-backend-definitions
                                 'hara "code.manage/scaffold")))
                     (location (xref-item-location xref)))
                (should (equal (file-truename (xref-file-location-file location))
                               (file-truename file)))
                (should (= (xref-file-location-line location) 3))
                (should-not requested)))))
      (delete-directory root t))))

(ert-deftest hara-interrupt-clears-owned-connection ()
  (let* ((root "/tmp/hara-interrupt/")
         (pending (make-hash-table :test #'equal))
         (connection (hara--make-connection
                      :root root :pending pending
                      :process 'network :server-process 'server))
         deleted failed)
    (puthash "E1" (list :failure (lambda (error) (setq failed error))) pending)
    (puthash root connection hara--connections)
    (with-temp-buffer
      (setq default-directory root)
      (setq-local hara--connection connection)
      (cl-letf (((symbol-function 'process-live-p) (lambda (_) t))
                ((symbol-function 'delete-process)
                 (lambda (process) (push process deleted)))
                ((symbol-function 'hara--delete-cache) #'ignore))
        (hara-interrupt))
      (should-not hara--connection))
    (should (equal failed '("INTERRUPTED" "Hara evaluation interrupted")))
    (should-not (gethash root hara--connections))
    (should (memq 'network deleted))
    (should (memq 'server deleted))))

(ert-deftest hara-symbol-at-point-handles-hara-symbol-constituents ()
  "Symbol extraction must include all hara identifier characters."
  (with-temp-buffer
    (hara-mode)
    (insert "(get *answer* :key) (<= 1 2) std.lib.foundation/map (str/encode x)")
    (dolist (expected '("get" "*answer*" ":key" "<=" "std.lib.foundation/map" "str/encode"))
      (goto-char (point-min))
      (search-forward expected)
      (goto-char (match-beginning 0))
      (forward-char (max 1 (/ (length expected) 2)))
      (should (equal (hara--symbol-at-point) expected)))))

(ert-deftest hara-last-sexp-bounds-completes-partial-symbol ()
  "Evaluating mid-symbol must send the full symbol, not a fragment."
  (with-temp-buffer
    (hara-mode)
    (insert "(mapv inc xs)")
    (goto-char (point-min))
    (search-forward "mapv")
    (goto-char (match-beginning 0))
    (forward-char 2)
    (let ((bounds (hara--last-sexp-bounds)))
      (should (equal (buffer-substring-no-properties (car bounds) (cdr bounds))
                     "mapv")))
    ;; After a complete form, the whole form is selected.
    (goto-char (point-max))
    (let ((bounds (hara--last-sexp-bounds)))
      (should (equal (buffer-substring-no-properties (car bounds) (cdr bounds))
                     "(mapv inc xs)")))))

(ert-deftest hara-symbol-at-point-works-in-dotted-names ()
  "Point inside a dotted namespace segment should return the full symbol."
  (with-temp-buffer
    (hara-mode)
    (insert "(std.lib/map 1 2)")
    (goto-char (point-min))
    (should (search-forward "lib"))
    (goto-char (match-beginning 0))
    (forward-char 1)
    (should (equal (hara--symbol-at-point) "std.lib/map"))))

(ert-deftest hara-last-sexp-bounds-handles-dotted-symbol-midpoint ()
  (with-temp-buffer
    (hara-mode)
    (insert "(str/encode x)")
    (goto-char (point-min))
    (search-forward "encode")
    (goto-char (match-beginning 0))
    (forward-char 3)
    (let ((bounds (hara--last-sexp-bounds)))
      (should (equal (buffer-substring-no-properties (car bounds) (cdr bounds))
                     "str/encode")))))

(ert-deftest hara-eval-last-sexp-and-inserts-result ()
  "Eval-and-insert should insert the runtime result at point."
  (with-temp-buffer
    (hara-mode)
    (insert "(+ 1 2) ")
    (let* ((process (make-pipe-process :name "hara-insert-test"
                                       :command '("cat") :noquery t))
           (hara--connection
            (hara--make-connection :process process
                                   :pending (make-hash-table :test #'equal))))
      (unwind-protect
          (cl-letf (((symbol-function 'hara--request)
                     (lambda (_connection _command _arguments success _error)
                       (funcall success "3"))))
            (hara-eval-last-sexp-and-insert)
            (should (string= (buffer-string) "(+ 1 2) 3")))
        (delete-process process)))))

;;; hara-mode-test.el ends here
