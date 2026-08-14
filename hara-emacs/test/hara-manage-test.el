;;; hara-manage-test.el --- Tests for hara-manage -*- lexical-binding: t; -*-

;;; Code:

(require 'ert)
(require 'cl-lib)
(require 'hara-manage)

(defun hara-manage-test--table (&rest pairs)
  "Return a string-keyed hash table from PAIRS."
  (let ((table (make-hash-table :test #'equal)))
    (while pairs
      (puthash (pop pairs) (pop pairs) table))
    table))

(defun hara-manage-test--payload-with-edit
    (path before after &optional create)
  "Return a payload containing one changed edit."
  (hara-manage-test--table
   "schema" hara-manage-editor-schema
   "edits"
   (list (hara-manage-test--table
          "path" path
          "before" before
          "after" after
          "changed" t
          "create" (if create t :json-false)))))

(ert-deftest hara-manage-command-includes-editor-protocol ()
  (let ((hara-manage-command "/usr/local/bin/hara"))
    (should
     (equal
      (hara-manage--command 'scaffold "demo.core" "/repo/" nil "5.8")
      '("/usr/local/bin/hara"
        "--project" "/repo/" "--offline"
        "manage" "scaffold" "demo.core"
        "--format" "editor-json"
        "--added" "5.8")))
    (should
     (equal
      (hara-manage--command 'purge "demo.core" "/repo/" t nil)
      '("/usr/local/bin/hara"
        "--project" "/repo/" "--offline"
        "manage" "purge" "demo.core"
        "--format" "editor-json" "--write")))))

(ert-deftest hara-manage-normalizes-test-namespace ()
  (should (equal (hara-manage--normalize-namespace "demo.core-test")
                 "demo.core"))
  (should (equal (hara-manage--normalize-namespace "demo.core")
                 "demo.core")))

(ert-deftest hara-manage-discovers-multiline-namespace ()
  (with-temp-buffer
    (insert "(ns\n  demo.core-test\n  (:require [std.test :refer [fact]]))\n")
    (should (equal (hara-manage--buffer-namespace) "demo.core"))))

(ert-deftest hara-manage-parses-editor-schema ()
  (let ((payload (hara-manage--parse-response
                  "{\"schema\":\"code.manage.editor/0-alpha\",\"edits\":[]}")))
    (should (hash-table-p payload)))
  (should-error
   (hara-manage--parse-response
    "{\"schema\":\"code.manage.editor/99\",\"edits\":[]}")))

(ert-deftest hara-manage-renders-unified-diff ()
  (let* ((edit (hara-manage-test--table
                "path" "test/demo/core_test.hal"
                "before" "old\n"
                "after" "new\n"
                "changed" t
                "create" :json-false))
         (diff (hara-manage--edit-diff edit)))
    (should (string-match-p "--- a/test/demo/core_test\\.hal" diff))
    (should (string-match-p "+++ b/test/demo/core_test\\.hal" diff))
    (should (string-match-p "^-old$" diff))
    (should (string-match-p "^+new$" diff))))

(ert-deftest hara-manage-renders-findings-as-compilation-lines ()
  (let ((finding (hara-manage-test--table
                  "path" "test/demo/core_test.hal"
                  "line" 12
                  "column" 3
                  "classification" "T"
                  "message" "TODO fact")))
    (should
     (equal (hara-manage--finding-line finding)
            "test/demo/core_test.hal:12:3: [T] TODO fact\n"))))

(ert-deftest hara-manage-rejects-stale-preview ()
  (let* ((root (make-temp-file "hara-manage" t))
         (relative "src/demo/core.hal")
         (path (expand-file-name relative root))
         (payload (hara-manage-test--payload-with-edit
                   relative "before\n" "after\n"))
         (preview (hara-manage-preview-create
                   :operation 'purge :namespace "demo.core"
                   :root root :payload payload)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory path) t)
          (with-temp-file path (insert "changed\n"))
          (should-error (hara-manage--verify-preview preview)
                        :type 'user-error))
      (delete-directory root t))))

(ert-deftest hara-manage-accepts-current-preview ()
  (let* ((root (make-temp-file "hara-manage" t))
         (relative "src/demo/core.hal")
         (path (expand-file-name relative root))
         (payload (hara-manage-test--payload-with-edit
                   relative "before\n" "after\n"))
         (preview (hara-manage-preview-create
                   :operation 'purge :namespace "demo.core"
                   :root root :payload payload)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory path) t)
          (with-temp-file path (insert "before\n"))
          (should (null (hara-manage--verify-preview preview))))
      (delete-directory root t))))

(ert-deftest hara-manage-rejects-relative-path-outside-project ()
  (let ((root (make-temp-file "hara-manage" t)))
    (unwind-protect
        (should-error
         (hara-manage--absolute-path root "../escaped.hal")
         :type 'user-error)
      (delete-directory root t))))

(ert-deftest hara-manage-rejects-absolute-path-outside-project ()
  (let ((root (make-temp-file "hara-manage" t)))
    (unwind-protect
        (should-error
         (hara-manage--absolute-path root "/tmp/escaped.hal")
         :type 'user-error)
      (delete-directory root t))))

(ert-deftest hara-manage-apply-preserves-added-override ()
  (let* ((payload (hara-manage-test--table
                   "schema" hara-manage-editor-schema
                   "edits" nil))
         (preview (hara-manage-preview-create
                   :operation 'scaffold :namespace "demo.core"
                   :root "/repo/" :added "5.8" :payload payload))
         calls)
    (cl-letf (((symbol-function 'hara-manage--verify-preview)
               (lambda (value) (push (list 'verify value) calls)))
              ((symbol-function 'hara-manage--save-project-buffers)
               (lambda (root) (push (list 'save root) calls)))
              ((symbol-function 'hara-manage--start-process)
               (lambda (value &optional write added)
                 (push (list 'start value write added) calls))))
      (hara-manage--apply preview))
    (setq calls (nreverse calls))
    (should (equal (mapcar #'car calls) '(verify save verify start)))
    (should (eq (nth 2 (nth 3 calls)) t))
    (should (equal (nth 3 (nth 3 calls)) "5.8"))))

(ert-deftest hara-manage-refresh-preserves-added-override ()
  (let ((hara-manage--preview
         (hara-manage-preview-create
          :operation 'scaffold :namespace "demo.core"
          :root "/repo/" :added "5.8"
          :payload (make-hash-table :test #'equal)))
        started)
    (cl-letf (((symbol-function 'hara-manage--save-project-buffers)
               (lambda (_root)))
              ((symbol-function 'hara-manage--start-process)
               (lambda (preview &optional _write _added)
                 (setq started preview))))
      (hara-manage-refresh-preview))
    (should (equal (hara-manage-preview-added started) "5.8"))))

(ert-deftest hara-manage-refreshes-unmodified-visiting-buffer-and-opens-create ()
  (let* ((root (make-temp-file "hara-manage" t))
         (relative "test/demo/core_test.hal")
         (path (expand-file-name relative root))
         (payload (hara-manage-test--payload-with-edit relative "old\n" "new\n" t))
         (preview (hara-manage-preview-create
                   :operation 'scaffold :namespace "demo.core"
                   :root root :payload payload))
         opened
         buffer)
    (unwind-protect
        (progn
          (make-directory (file-name-directory path) t)
          (with-temp-file path (insert "old\n"))
          (setq buffer (find-file-noselect path))
          (with-temp-file path (insert "new\n"))
          (cl-letf (((symbol-function 'find-file)
                     (lambda (file) (setq opened file))))
            (hara-manage--refresh-visiting-buffers preview payload))
          (with-current-buffer buffer
            (should (equal (buffer-string) "new\n")))
          (should (equal opened path)))
      (when (buffer-live-p buffer) (kill-buffer buffer))
      (delete-directory root t))))

(ert-deftest hara-manage-prefix-bindings-match-workflows ()
  (should (eq (lookup-key hara-manage-prefix-map (kbd "s"))
              #'hara-manage-scaffold))
  (should (eq (lookup-key hara-manage-prefix-map (kbd "i"))
              #'hara-manage-import))
  (should (eq (lookup-key hara-manage-prefix-map (kbd "p"))
              #'hara-manage-purge))
  (should (eq (lookup-key hara-manage-prefix-map (kbd "n"))
              #'hara-manage-incomplete))
  (should (eq (lookup-key hara-manage-prefix-map (kbd "d"))
              #'hara-manage-pedantic)))

(ert-deftest hara-manage-rejects-symlinked-editor-paths-outside-project ()
  (let* ((root (make-temp-file "hara-manage-root" t))
         (outside (make-temp-file "hara-manage-outside" t))
         (link (expand-file-name "linked" root)))
    (unwind-protect
        (progn
          (make-symbolic-link outside link)
          (should-error
           (hara-manage--absolute-path root "linked/escaped.hal")
           :type 'user-error))
      (delete-directory root t)
      (delete-directory outside t))))

(ert-deftest hara-manage-integrates-with-hara-mode-map ()
  (require 'hara-mode)
  (should (eq (lookup-key hara-mode-map (kbd "C-c m s"))
              #'hara-manage-scaffold))
  (should (eq (lookup-key hara-mode-map (kbd "C-c m i"))
              #'hara-manage-import))
  (should (eq (lookup-key hara-mode-map (kbd "C-c m p"))
              #'hara-manage-purge))
  (should (eq (lookup-key hara-mode-map (kbd "C-c m n"))
              #'hara-manage-incomplete))
  (should (eq (lookup-key hara-mode-map (kbd "C-c m d"))
              #'hara-manage-pedantic))
  (should (eq (lookup-key hara-mode-map (kbd "C-c m m"))
              #'hara-manage-dispatch)))

(provide 'hara-manage-test)
;;; hara-manage-test.el ends here
