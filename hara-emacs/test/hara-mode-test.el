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

(ert-deftest hara-error-frame-retains-structured-details ()
  (let* ((connection
          (hara--make-connection
           :pending (make-hash-table :test #'equal)))
         (process (make-pipe-process :name "hara-error-details-test"
                                     :command '("cat") :noquery t)))
    (unwind-protect
        (progn
          (process-put process 'hara-negotiated t)
          (process-put process 'hara-connection connection)
          (puthash "E1" (list :failure #'ignore)
                   (hara-connection-pending connection))
          (hara--handle-frame
           process
           '("ERROR" "E1" "EVAL_ERROR" "outer: top-level form 1: bad"
             "[hara stack]" "  at coroutine"))
          (should (equal (plist-get
                          (gethash "E1" (hara-connection-pending connection))
                          :error)
                         '("EVAL_ERROR" "outer: top-level form 1: bad"
                           :details ("[hara stack]" "  at coroutine")))))
      (delete-process process))))

(ert-deftest hara-error-contexts-extract-nested-namespaces ()
  (should (equal
           (hara--error-contexts
            '("EVAL_ERROR"
              "lang.outer: top-level form 1: lang.inner.core: top-level form 7: unbound symbol: resolve"))
           '(("lang.outer" 1) ("lang.inner.core" 7)))))

(ert-deftest hara-error-buffer-prints-source-contexts ()
  (let* ((root (make-temp-file "hara-error-project-" t))
         (file (expand-file-name "src/lang/base/v1/grammar_spec.hal" root)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory file) t)
          (with-temp-file (expand-file-name "project.edn" root) (insert "{}"))
          (with-temp-file file
            (insert "(ns lang.base.v1.grammar-spec)\n"
                    "(def first 1)\n"
                    "(def second resolve)\n"))
          (with-temp-buffer
            (setq default-directory root)
            (cl-letf (((symbol-function 'display-buffer) #'ignore))
              (hara--show-error
               '("EVAL_ERROR"
                 "lang.base.v1.grammar-spec: top-level form 3: unbound symbol: resolve"
                 :details ("[hara stack]" "  at coroutine/fiber"))))
            (with-current-buffer "*Hara Error*"
              (should (string-match-p "Source contexts:" (buffer-string)))
              (should (string-match-p "lang.base.v1.grammar-spec: top-level form 3"
                                      (buffer-string)))
              (should (string-match-p "grammar_spec.hal:3:1" (buffer-string)))
              (should (string-match-p "coroutine/fiber" (buffer-string))))))
      (when (get-buffer "*Hara Error*") (kill-buffer "*Hara Error*"))
      (delete-directory root t))))

(ert-deftest hara-error-buffer-renders-clickable-structured-frames ()
  (let* ((root (make-temp-file "hara-diagnostic-project-" t))
         (file (expand-file-name "src/sample.hal" root))
         (diagnostic
          `("VERSION" 1
            "MESSAGE" "thrown: bad input"
            "EXCEPTION" ("MESSAGE" "bad input"
                         "CLASS" ":ex.class/argument"
                         "CODE" ":test/failed"
                         "DATA" "{:value 41}"
                         "CAUSE" nil)
            "PRIMARY" ("FILE" ,file "LINE" 3 "COLUMN" 8)
            "EXCERPT" ("START-LINE" 2
                       "TEXT" "(defn boom []\n  (throw bad))")
            "FRAMES" (("FUNCTION" "boom"
                       "NAMESPACE" "sample"
                       "FILE" ,file
                       "LINE" 3
                       "COLUMN" 8)))))
    (unwind-protect
        (progn
          (make-directory (file-name-directory file) t)
          (with-temp-file (expand-file-name "project.edn" root) (insert "{}"))
          (with-temp-file file
            (insert "(ns sample)\n(defn boom []\n  (throw bad))\n"))
          (with-temp-buffer
            (setq default-directory root)
            (cl-letf (((symbol-function 'display-buffer) #'ignore))
              (hara--show-error
               `("EVAL_ERROR" "thrown: bad input" :details (,diagnostic))))
            (with-current-buffer "*Hara Error*"
              (should (derived-mode-p 'hara-error-mode))
              (should (string-match-p "Exception:" (buffer-string)))
              (should (string-match-p "Source excerpt:" (buffer-string)))
              (should (string-match-p "Backtrace:" (buffer-string)))
              (goto-char (point-min))
              (search-forward "sample/boom")
              (should (button-at (1- (point)))))))
      (when (get-buffer "*Hara Error*") (kill-buffer "*Hara Error*"))
      (delete-directory root t))))

(ert-deftest hara-resp-encodes-utf8-by-byte-length ()
  (let ((encoded (hara--resp-encode-value "hé")))
    (should (equal encoded
                   (concat "$3\r\n"
                           (encode-coding-string "hé" 'utf-8 t)
                           "\r\n")))))

(ert-deftest hara-defaults-to-the-requested-lite-runtime ()
  (when (file-executable-p "/home/hoebat/.local/bin/hara-rust-lite")
    (should (equal hara-command "/home/hoebat/.local/bin/hara-rust-lite"))))

(ert-deftest hara-eglot-registration-uses-the-shared-language-server ()
  (require 'eglot)
  (let ((eglot-server-programs
         (cl-remove-if (lambda (entry) (eq (car entry) 'hara-mode))
                       eglot-server-programs)))
    (hara--eglot-register)
    (let ((entry (assq 'hara-mode eglot-server-programs)))
      (should entry)
      (should (equal (funcall (cdr entry)) hara-lsp-command))
      (should (equal (funcall (cdr entry) nil) hara-lsp-command)))))

(ert-deftest hara-eglot-contact-includes-the-canonical-project-root ()
  (let* ((root (make-temp-file "hara-eglot-project-" t))
         (source (expand-file-name "src/sample.hal" root)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory source) t)
          (with-temp-file (expand-file-name "project.edn" root)
            (insert "{}"))
          (with-temp-buffer
            (setq-local buffer-file-name source)
            (let ((hara-lsp-command '("hara-lsp" "--stdio")))
              (should (equal (hara--eglot-contact)
                             (list "hara-lsp" "--stdio"
                                   "--root"
                                   (file-name-as-directory
                                    (file-truename root))))))))
      (delete-directory root t))))

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

(ert-deftest hara-async-endpoint-uses-a-nonblocking-connect ()
  (let (arguments)
    (cl-letf (((symbol-function 'make-network-process)
               (lambda (&rest values)
                 (setq arguments values)
                 'fake-network))
              ((symbol-function 'process-put) #'ignore))
      (hara--make-endpoint-connection
       "/tmp/hara-project/" "127.0.0.1" 1311 nil t))
    (should (eq (plist-get arguments :nowait) t))))

(ert-deftest hara-async-endpoint-sends-hello-after-connect ()
  (let (sent)
    (cl-letf (((symbol-function 'process-get)
               (lambda (_process property)
                 (and (eq property 'hara-open-callback)
                      (lambda (&rest _)
                        (ert-fail "the open callback must wait for HELLO")))))
              ((symbol-function 'process-put) #'ignore)
              ((symbol-function 'process-live-p) (lambda (_) t))
              ((symbol-function 'hara--send-value)
               (lambda (process value)
                 (setq sent (list process value)))))
      (hara--process-sentinel 'fake-network "open\n"))
    (should (equal sent '(fake-network ("HELLO" "4" "CLIENT" "EMACS"))))))

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

(ert-deftest hara-resolve-command-prefers-project-edn-bin ()
  (let* ((root (make-temp-file "hara-project-bin-" t))
         (source (expand-file-name "src/demo.hal" root))
         (launcher (expand-file-name "bin/hara" root)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory source) t)
          (make-directory (file-name-directory launcher) t)
          (with-temp-file (expand-file-name "project.edn" root)
            (insert "{:project/hara-bin \"bin/hara\"\n"
                    " :project/distribution {:project/hara-bin \"ignored\"}}"))
          (with-temp-file launcher (insert "#!/bin/sh\n"))
          (set-file-modes launcher #o755)
          (with-temp-buffer
            (setq-local buffer-file-name source)
            (let ((hara-command "/bin/sh"))
              (should (equal (hara--resolve-command)
                             (file-truename launcher))))))
      (delete-directory root t))))

(ert-deftest hara-project-edn-bin-is-limited-to-the-top-level-project-map ()
  (let ((root (make-temp-file "hara-project-bin-nested-" t)))
    (unwind-protect
        (progn
          (with-temp-file (expand-file-name "project.edn" root)
            (insert "{:project/distribution {:project/hara-bin \"ignored\"}}\n"))
          (should-not (hara--project-edn-string root ":project/hara-bin")))
      (delete-directory root t))))

(ert-deftest hara-resolve-command-rejects-a-missing-project-edn-bin ()
  (let* ((root (make-temp-file "hara-project-bin-missing-" t))
         (source (expand-file-name "src/demo.hal" root)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory source) t)
          (with-temp-file (expand-file-name "project.edn" root)
            (insert "{:project/hara-bin \"bin/missing-hara\"}"))
          (with-temp-buffer
            (setq-local buffer-file-name source)
            (let ((hara-command "/bin/sh"))
              (should-error (hara--resolve-command) :type 'user-error))))
      (delete-directory root t))))

(ert-deftest hara-resolve-command-rejects-a-project-edn-bin-directory ()
  (let* ((root (make-temp-file "hara-project-bin-directory-" t))
         (source (expand-file-name "src/demo.hal" root)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory source) t)
          (make-directory (expand-file-name "bin/hara" root) t)
          (with-temp-file (expand-file-name "project.edn" root)
            (insert "{:project/hara-bin \"bin/hara\"}"))
          (with-temp-buffer
            (setq-local buffer-file-name source)
            (let ((hara-command "/bin/sh"))
              (should-error (hara--resolve-command) :type 'user-error))))
      (delete-directory root t))))

(ert-deftest hara-mode-auto-jacks-in-only-for-project-files ()
  (let* ((root (make-temp-file "hara-auto-project-" t))
         (standalone-root (make-temp-file "hara-standalone-" t))
         (source-directory (expand-file-name "src" root))
         (source-file (expand-file-name "sample.hal" source-directory))
         scheduled
         auto-started)
    (unwind-protect
        (progn
          (make-directory source-directory)
          (with-temp-file (expand-file-name "project.edn" root)
            (insert "{:hara/type :project :project/id auto}"))
          (clrhash hara--project-autostart-state)
          (with-temp-buffer
            (setq-local buffer-file-name source-file)
            (cl-letf (((symbol-function 'run-at-time)
                       (lambda (_seconds _repeat function &rest arguments)
                         (setq scheduled (cons function arguments))
                         'fake-timer))
                      ((symbol-function 'hara--maybe-start-eglot) #'ignore))
              (hara-mode)
              (should scheduled)
              (should-not auto-started)
              (should (equal (hara--project-file-root)
                             (file-name-as-directory (file-truename root)))))
          (cl-letf (((symbol-function 'hara--auto-jack-in)
                     (lambda (project-root)
                       (setq auto-started project-root))))
            (apply (car scheduled) (cdr scheduled)))
          (should (equal auto-started
                         (file-name-as-directory (file-truename root))))
          (setq scheduled nil)
          (with-temp-buffer
            (setq-local buffer-file-name source-file)
            (cl-letf (((symbol-function 'run-at-time)
                       (lambda (&rest _)
                         (ert-fail "the project must only schedule startup once")))
                      ((symbol-function 'hara--maybe-start-eglot) #'ignore))
              (hara-mode)))
          (should-not scheduled)
          (with-temp-buffer
            (setq-local buffer-file-name
                        (expand-file-name "standalone.hal"
                                          standalone-root))
            (cl-letf (((symbol-function 'run-at-time)
                       (lambda (&rest _)
                         (ert-fail "standalone files must not schedule startup")))
                      ((symbol-function 'hara--maybe-start-eglot) #'ignore))
              (hara-mode)
              (should-not (hara--project-file-root)))))
      (delete-directory root t)
      (delete-directory standalone-root t)
      (clrhash hara--project-autostart-state)))))

(ert-deftest hara-lsp-diagnose-buffer-sends-current-unsaved-source ()
  (with-temp-buffer
    (setq-local buffer-file-name "/tmp/hara-diagnose/sample.hal")
    (setq-local eglot--versioned-identifier 7)
    (insert "(ns sample.core)\n(def answer missing)")
    (let (request)
      (cl-letf (((symbol-function 'hara--eglot-managed-p) (lambda () t))
                ((symbol-function 'eglot-current-server) (lambda () 'server))
                ((symbol-function 'eglot--path-to-uri)
                 (lambda (path) (concat "file://" path)))
                ((symbol-function 'jsonrpc-async-request)
                 (lambda (server method params &rest options)
                   (setq request (list server method params options)))))
        (hara-lsp-diagnose-buffer))
      (should (equal (nth 0 request) 'server))
      (should (eq (nth 1 request) :hara/diagnostics))
      (should (equal (nth 2 request)
                     '(:uri "file:///tmp/hara-diagnose/sample.hal"
                       :text "(ns sample.core)\n(def answer missing)"
                       :version 7)))
      (should (equal (plist-get (nth 3 request) :timeout) 30)))))

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

(ert-deftest hara-source-test-counterpart-supports-native-layouts ()
  (let* ((root (make-temp-file "hara-pair-project-" t))
         (source (expand-file-name "lib/src/tool/example.hal" root))
         (test (expand-file-name "lib/test/tool/example_test.hal" root)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory source) t)
          (make-directory (file-name-directory test) t)
          (with-temp-file (expand-file-name "project.edn" root) (insert "{}"))
          (with-temp-file source (insert "(ns tool.example)"))
          (with-temp-file test (insert "(ns tool.example-test)"))
          (with-temp-buffer
            (setq-local buffer-file-name source)
            (should (equal (hara--source-test-counterpart source)
                           (file-truename test)))
            (should (equal (hara--focused-test-file source)
                           (file-truename test))))
          (with-temp-buffer
            (setq-local buffer-file-name test)
            (should (equal (hara--source-test-counterpart test)
                           (file-truename source)))
            (should (equal (hara--focused-test-file test) test))))
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
    (should (member 'imenu eglot-stay-out-of))
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

(ert-deftest hara-completion-filters-host-implementation-namespaces ()
  (let ((candidates (hara--completion-candidates
                     '("co/std.native.Algo" "std.native.Coroutine"
                       "std.foundation/resolve")
                     "")))
    (should-not (member "co/std.native.Algo" candidates))
    (should-not (member "std.native.Coroutine" candidates))
    (should (member "std.foundation/resolve" candidates))))

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

(ert-deftest hara-buffer-namespace-context-preserves-the-complete-ns-form ()
  (with-temp-buffer
    (hara-mode)
    (insert "; heading\n"
            "(ns sample.core\n"
            "  (:require [std.foundation.string :as str]))\n\n"
            "(def answer 42)\n")
    (let ((context (hara--buffer-namespace-context)))
      (should (equal (plist-get context :name) "sample.core"))
      (should (equal (plist-get context :source)
                     (concat "(ns sample.core\n"
                             "  (:require [std.foundation.string :as str]))")))
      (should (= (plist-get context :start) 11)))))

(ert-deftest hara-eval-synchronises-the-buffer-namespace-before-the-form ()
  (with-temp-buffer
    (setq-local buffer-file-name "/tmp/sample.hal")
    (insert "(ns sample.core\n  (:require [std.foundation.string :as str]))\n"
            "(def answer (str/upper \"ok\"))")
    (let ((connection
           (hara--make-connection
            :namespace "other.core"
            :pending (make-hash-table :test #'equal)))
          requests
          result)
      (cl-letf (((symbol-function 'hara--request)
                 (lambda (_connection operation arguments success &optional _failure)
                   (push (cons operation arguments) requests)
                   (funcall success (if (= (length requests) 1) "sample.core" "value")))))
        (hara--eval-in-buffer-namespace
         connection '("(def answer 42)")
         (lambda (value) (setq result value)) #'ignore))
      (setq requests (nreverse requests))
      (should (equal (mapcar #'car requests) '("EVAL" "EVAL")))
      (should (string-prefix-p "(ns sample.core" (cadr (car requests))))
      (should (equal (cdr (cadr requests)) '("(def answer 42)")))
      (should (equal (hara-connection-namespace connection) "sample.core"))
      (should (equal result "value")))))

(ert-deftest hara-eval-reuses-an-already-synchronised-namespace ()
  (with-temp-buffer
    (insert "(ns sample.core)\n(def answer 42)")
    (let ((connection
           (hara--make-connection
            :namespace "sample.core"
            :pending (make-hash-table :test #'equal)))
          requests)
      (cl-letf (((symbol-function 'hara--request)
                 (lambda (_connection operation arguments success &optional _failure)
                   (push (cons operation arguments) requests)
                   (funcall success "value"))))
        (hara--eval-in-buffer-namespace
         connection '("(def answer 42)") #'ignore #'ignore))
      (should (equal requests '(("EVAL" "(def answer 42)")))))))

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

(ert-deftest hara-xref-references-ignore-comments-and-strings ()
  (let* ((root (make-temp-file "hara-xref-references-" t))
         (file (expand-file-name "lib/src/demo/core.hal" root)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory file) t)
          (with-temp-file (expand-file-name "project.edn" root) (insert "{}"))
          (with-temp-file file
            (insert "(ns demo.core)\n"
                    "(defn answer [] 1)\n"
                    "(def result (answer))\n"
                    "; answer\n"
                    "\"answer\"\n"))
          (with-temp-buffer
            (setq default-directory root)
            (let ((references (xref-backend-references 'hara "answer")))
              (should (= (length references) 2))
              (should (equal (mapcar (lambda (reference)
                                       (xref-file-location-line
                                        (xref-item-location reference)))
                                     references)
                             '(2 3))))))
      (delete-directory root t))))

(ert-deftest hara-project-find-uses-project-edn-root ()
  (let ((root (make-temp-file "hara-project-find-" t)))
    (unwind-protect
        (progn
          (with-temp-file (expand-file-name "project.edn" root) (insert "{}"))
          (should (equal (hara--project-find root)
                         (cons 'hara (file-name-as-directory
                                      (file-truename root)))))
          (should (equal (project-root (hara--project-find root))
                         (file-name-as-directory (file-truename root)))))
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

(ert-deftest hara-connected-mode-keeps-the-project-server-alive-between-buffers ()
  (let ((connection
         (hara--make-connection
          :root "/tmp/hara-persistent/" :process 'network
          :server-process 'server :refs 0))
        disconnected)
    (with-temp-buffer
      (setq-local hara--connection connection)
      (cl-letf (((symbol-function 'process-live-p) (lambda (_) t))
                ((symbol-function 'hara--disconnect)
                 (lambda (_) (setq disconnected t))))
        (hara-connected-mode 1)
        (hara-connected-mode -1)))
    (should (= (hara-connection-refs connection) 0))
    (should-not disconnected)))

(ert-deftest hara-dead-process-detaches-the-stale-project-connection ()
  (let* ((root "/tmp/hara-dead-process/")
         (connection
          (hara--make-connection
           :root root :pending (make-hash-table :test #'equal) :refs 0))
         (buffer (generate-new-buffer " *hara-dead-process-test*")))
    (unwind-protect
        (progn
          (puthash root connection hara--connections)
          (with-current-buffer buffer
            (setq-local hara--connection connection)
            (hara-connected-mode 1))
          (cl-letf (((symbol-function 'process-live-p) (lambda (_) nil))
                    ((symbol-function 'process-get)
                     (lambda (_process property)
                       (and (eq property 'hara-connection) connection))))
            (hara--process-sentinel 'dead "connection broken\n"))
          (with-current-buffer buffer
            (should-not hara--connection)
            (should-not hara-connected-mode))
          (should (= (hara-connection-refs connection) 0))
          (should-not (gethash root hara--connections)))
      (remhash root hara--connections)
      (kill-buffer buffer))))

(ert-deftest hara-repl-buffers-are-project-specific ()
  (let* ((first (hara--make-connection :root "/tmp/project-a/"))
         (second (hara--make-connection :root "/tmp/project-b/"))
         (first-buffer (hara--repl-buffer first))
         (second-buffer (hara--repl-buffer second)))
    (unwind-protect
        (progn
          (should-not (eq first-buffer second-buffer))
          (should (equal (buffer-name first-buffer) "*Hara REPL project-a*"))
          (should (equal (buffer-name second-buffer) "*Hara REPL project-b*")))
      (kill-buffer first-buffer)
      (kill-buffer second-buffer))))

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
