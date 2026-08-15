;;; hara-manage.el --- code.manage integration for Hara -*- lexical-binding: t; -*-

;; Copyright (C) 2026 Hara contributors
;; Package-Requires: ((emacs "29.1"))
;; Keywords: languages, tools
;; URL: https://github.com/hara-lang/hara-extensions

;;; Commentary:

;; Preview and apply Foundation-compatible code.manage operations against the
;; namespace in the current Hara buffer.  Editing commands render a unified diff
;; and rerun the native CLI with --write only after confirmation and a stale
;; preview check.  Reporting commands use compilation-mode locations.

;;; Code:

(require 'cl-lib)
(require 'compile)
(require 'diff-mode)
(require 'json)
(require 'project nil t)
(require 'subr-x)

(defgroup hara-manage nil
  "Hara code.manage integration."
  :group 'languages
  :prefix "hara-manage-")

(defcustom hara-manage-command "hara"
  "Native Hara CLI executable."
  :type 'string
  :group 'hara-manage)

(defcustom hara-manage-prompt-after-preview t
  "Prompt to apply editing operations after rendering their preview."
  :type 'boolean
  :group 'hara-manage)

(defconst hara-manage-editor-schema "code.manage.editor/0-alpha")
(defconst hara-manage-editing-operations '(scaffold import purge))
(defconst hara-manage-reporting-operations '(incomplete pedantic))

(cl-defstruct (hara-manage-preview
               (:constructor hara-manage-preview-create))
  operation namespace root added payload)

(defvar hara-manage--process nil)
(defvar hara-manage-after-write-hook nil
  "Hook run after a code.manage write completes successfully.")
(defvar-local hara-manage--preview nil)

(defun hara-manage--json-get (object key &optional default)
  "Read KEY from JSON OBJECT, returning DEFAULT when absent."
  (if (hash-table-p object)
      (gethash key object default)
    default))

(defun hara-manage--json-true-p (value)
  "Return non-nil when VALUE is a JSON true value."
  (and value (not (eq value :json-false))))

(defun hara-manage--normalize-namespace (namespace)
  "Normalize test NAMESPACE to its corresponding source namespace."
  (if (string-suffix-p "-test" namespace)
      (substring namespace 0 (- (length namespace) 5))
    namespace))

(defun hara-manage--buffer-namespace ()
  "Return the source namespace declared by the current Hara buffer."
  (save-excursion
    (goto-char (point-min))
    (let ((case-fold-search nil))
      (unless (re-search-forward
               "^[[:space:]]*(ns\\(?:+\\)?[[:space:]\n]+\\([^][(){}[:space:]]+\\)"
               nil t)
        (user-error "Current buffer does not declare an ns or ns+ namespace"))
      (hara-manage--normalize-namespace
       (match-string-no-properties 1)))))

(defun hara-manage--project-root ()
  "Return the project.edn root for the current buffer."
  (let* ((start (or (and buffer-file-name
                         (file-name-directory buffer-file-name))
                    default-directory))
         (root (locate-dominating-file start "project.edn")))
    (unless root
      (user-error "No project.edn found above %s" start))
    (file-name-as-directory (expand-file-name root))))

(defun hara-manage--editing-operation-p (operation)
  "Return non-nil when OPERATION is an editing operation."
  (memq operation hara-manage-editing-operations))

(defun hara-manage--save-project-buffers (root)
  "Save modified Hara buffers visiting files beneath ROOT."
  (dolist (buffer (buffer-list))
    (with-current-buffer buffer
      (when (and buffer-file-name
                 (string-equal (file-name-extension buffer-file-name) "hal")
                 (file-in-directory-p (expand-file-name buffer-file-name) root)
                 (buffer-modified-p))
        (save-buffer)))))

(defun hara-manage--command (operation namespace root &optional write added)
  "Build a native CLI command for OPERATION and NAMESPACE under ROOT.
Append --write when WRITE is non-nil and --added ADDED when supplied."
  (append
   (list hara-manage-command
         "--project" root
         "--offline"
         "manage"
         (symbol-name operation)
         namespace
         "--format" "editor-json")
   (when added (list "--added" added))
   (when write (list "--write"))))

(defun hara-manage--parse-response (text)
  "Parse and validate an editor JSON response from TEXT."
  (let* ((payload (json-parse-string
                   (string-trim text)
                   :object-type 'hash-table
                   :array-type 'list
                   :null-object nil
                   :false-object :json-false))
         (schema (hara-manage--json-get payload "schema")))
    (unless (equal schema hara-manage-editor-schema)
      (error "Unsupported code.manage editor schema: %S" schema))
    payload))

(defun hara-manage--absolute-path (root path)
  "Resolve editor PATH beneath ROOT, rejecting paths that escape it."
  (unless (and (stringp path) (not (string-empty-p path)))
    (user-error "Code.manage returned an invalid edit path: %S" path))
  (let* ((root (file-name-as-directory (expand-file-name root)))
         (resolved (expand-file-name path root)))
    (unless (file-in-directory-p resolved root)
      (user-error "Code.manage edit escapes project root: %s" path))
    resolved))

(defun hara-manage--read-file-or-empty (path)
  "Read PATH literally, or return an empty string when it does not exist."
  (if (file-exists-p path)
      (with-temp-buffer
        (insert-file-contents-literally path)
        (buffer-string))
    ""))

(defun hara-manage--changed-edits (payload)
  "Return changed edit records from PAYLOAD."
  (cl-remove-if-not
   (lambda (edit)
     (hara-manage--json-true-p
      (hara-manage--json-get edit "changed")))
   (hara-manage--json-get payload "edits" nil)))

(defun hara-manage--line-count (text)
  "Return the unified-diff line count for TEXT."
  (if (string-empty-p text)
      0
    (with-temp-buffer
      (insert text)
      (count-lines (point-min) (point-max)))))

(defun hara-manage--diff-lines (text prefix)
  "Prefix each line in TEXT with PREFIX for a unified diff."
  (if (string-empty-p text)
      ""
    (with-temp-buffer
      (insert text)
      (goto-char (point-min))
      (while (not (eobp))
        (insert prefix)
        (forward-line 1))
      (unless (bolp)
        (insert "\n"))
      (buffer-string))))

(defun hara-manage--edit-diff (edit)
  "Render EDIT as a valid whole-file unified diff."
  (let* ((path (hara-manage--json-get edit "path"))
         (before (or (hara-manage--json-get edit "before") ""))
         (after (or (hara-manage--json-get edit "after") ""))
         (create (hara-manage--json-true-p
                  (hara-manage--json-get edit "create")))
         (before-lines (hara-manage--line-count before))
         (after-lines (hara-manage--line-count after)))
    (concat
     "--- " (if create "/dev/null" (concat "a/" path)) "\n"
     "+++ b/" path "\n"
     (format "@@ -1,%d +1,%d @@\n" before-lines after-lines)
     (hara-manage--diff-lines before "-")
     (hara-manage--diff-lines after "+"))))

(defun hara-manage--preview-buffer-name (operation)
  "Return a preview buffer name for OPERATION."
  (format "*hara manage %s*" operation))

(defvar hara-manage-preview-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "a") #'hara-manage-apply)
    (define-key map (kbd "g") #'hara-manage-refresh-preview)
    (define-key map (kbd "q") #'quit-window)
    map)
  "Keymap for `hara-manage-preview-mode'.")

(define-derived-mode hara-manage-preview-mode diff-mode "Hara-Manage"
  "Major mode for Hara code.manage edit previews."
  (setq-local truncate-lines t))

(defun hara-manage--render-edits (preview)
  "Render edit PREVIEW and return its display buffer."
  (let* ((payload (hara-manage-preview-payload preview))
         (edits (hara-manage--changed-edits payload))
         (buffer (get-buffer-create
                  (hara-manage--preview-buffer-name
                   (hara-manage-preview-operation preview)))))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (dolist (edit edits)
          (insert (hara-manage--edit-diff edit) "\n"))
        (goto-char (point-min))
        (hara-manage-preview-mode)
        (setq-local default-directory (hara-manage-preview-root preview))
        (setq-local hara-manage--preview preview)))
    (display-buffer buffer)
    buffer))

(defun hara-manage--finding-line (finding)
  "Render one FINDING as a `compilation-mode' location."
  (let ((path (or (hara-manage--json-get finding "path") "<unknown>"))
        (line (or (hara-manage--json-get finding "line") 1))
        (column (or (hara-manage--json-get finding "column") 1))
        (classification (hara-manage--json-get finding "classification"))
        (message (or (hara-manage--json-get finding "message") "finding")))
    (format "%s:%s:%s: %s%s\n"
            path line column
            (if classification (format "[%s] " classification) "")
            message)))

(defun hara-manage--render-findings (preview)
  "Render findings from PREVIEW in a compilation buffer."
  (let* ((payload (hara-manage-preview-payload preview))
         (operation (hara-manage-preview-operation preview))
         (findings (hara-manage--json-get payload "findings" nil))
         (buffer (get-buffer-create
                  (hara-manage--preview-buffer-name operation))))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (dolist (finding findings)
          (insert (hara-manage--finding-line finding)))
        (goto-char (point-min))
        (setq-local default-directory (hara-manage-preview-root preview))
        (compilation-mode)))
    (display-buffer buffer)
    buffer))

(defun hara-manage--verify-preview (preview)
  "Ensure every edit in PREVIEW still matches its on-disk before content."
  (let ((root (hara-manage-preview-root preview)))
    (dolist (edit (hara-manage--changed-edits
                   (hara-manage-preview-payload preview)))
      (let* ((path (hara-manage--absolute-path
                    root
                    (hara-manage--json-get edit "path")))
             (before (or (hara-manage--json-get edit "before") ""))
             (current (hara-manage--read-file-or-empty path)))
        (unless (equal current before)
          (user-error "Stale code.manage preview for %s; preview again" path))))))

(defun hara-manage--refresh-visiting-buffers (preview payload)
  "Refresh unmodified visiting buffers after applying PAYLOAD for PREVIEW."
  (let ((root (hara-manage-preview-root preview))
        (created nil))
    (dolist (edit (hara-manage--json-get payload "edits" nil))
      (when (hara-manage--json-true-p
             (hara-manage--json-get edit "changed"))
        (let* ((path (hara-manage--absolute-path
                      root
                      (hara-manage--json-get edit "path")))
               (buffer (find-buffer-visiting path)))
          (when (and buffer
                     (not (buffer-modified-p buffer)))
            (with-current-buffer buffer
              (revert-buffer :ignore-auto :noconfirm)))
          (when (hara-manage--json-true-p
                 (hara-manage--json-get edit "create"))
            (setq created path)))))
    (when created
      (find-file created))))

(defun hara-manage--process-output (process)
  "Return PROCESS output and dispose of its hidden transport buffer."
  (let ((buffer (process-buffer process)))
    (unwind-protect
        (when (buffer-live-p buffer)
          (with-current-buffer buffer (buffer-string)))
      (when (buffer-live-p buffer)
        (kill-buffer buffer)))))

(defun hara-manage--process-sentinel (process _event)
  "Handle a native CLI PROCESS completion."
  (when (memq (process-status process) '(exit signal))
    (when (eq process hara-manage--process)
      (setq hara-manage--process nil))
    (let* ((exit (process-exit-status process))
           (output (or (hara-manage--process-output process) ""))
           (preview (process-get process 'hara-manage-preview))
           (applying (process-get process 'hara-manage-applying)))
      (if (not (zerop exit))
          (progn
            (with-current-buffer (get-buffer-create "*hara manage error*")
              (let ((inhibit-read-only t))
                (erase-buffer)
                (insert output)
                (special-mode))
              (display-buffer (current-buffer)))
            (message "hara manage failed with status %d" exit))
        (condition-case error
            (let* ((payload (hara-manage--parse-response output))
                   (completed
                    (hara-manage-preview-create
                     :operation (hara-manage-preview-operation preview)
                     :namespace (hara-manage-preview-namespace preview)
                     :root (hara-manage-preview-root preview)
                     :added (hara-manage-preview-added preview)
                     :payload payload)))
              (if applying
                  (progn
                    (hara-manage--refresh-visiting-buffers completed payload)
                    (run-hooks 'hara-manage-after-write-hook)
                    (message "hara manage %s applied"
                             (hara-manage-preview-operation completed)))
                (if (hara-manage--editing-operation-p
                     (hara-manage-preview-operation completed))
                    (let ((edits (hara-manage--changed-edits payload)))
                      (hara-manage--render-edits completed)
                      (if (null edits)
                          (message "hara manage %s: no changes"
                                   (hara-manage-preview-operation completed))
                        (when (and hara-manage-prompt-after-preview
                                   (y-or-n-p
                                    (format "Apply hara manage %s changes? "
                                            (hara-manage-preview-operation completed))))
                          (hara-manage--apply completed))))
                  (hara-manage--render-findings completed))))
          (error
           (message "Invalid hara manage response: %s"
                    (error-message-string error))))))))

(defun hara-manage--start-process (preview &optional write added)
  "Start PREVIEW operation asynchronously; WRITE reruns with --write.
When ADDED is nil, preserve the override stored in PREVIEW."
  (when (process-live-p hara-manage--process)
    (user-error "A hara manage command is already running"))
  (let* ((operation (hara-manage-preview-operation preview))
         (namespace (hara-manage-preview-namespace preview))
         (root (hara-manage-preview-root preview))
         (added (or added (hara-manage-preview-added preview)))
         (buffer (generate-new-buffer " *hara-manage-process*"))
         (command (hara-manage--command operation namespace root write added))
         (process
          (make-process
           :name (format "hara-manage-%s" operation)
           :buffer buffer
           :stderr buffer
           :command command
           :noquery t
           :connection-type 'pipe
           :sentinel #'hara-manage--process-sentinel)))
    (process-put process 'hara-manage-preview preview)
    (process-put process 'hara-manage-applying write)
    (setq hara-manage--process process)
    (message "Running hara manage %s for %s" operation namespace)
    process))

;;;###autoload
(defun hara-manage-cancel ()
  "Cancel the active non-writing code.manage operation.
An apply operation cannot be cancelled because doing so could leave a partial
write on disk."
  (interactive)
  (unless (process-live-p hara-manage--process)
    (user-error "No hara manage command is running"))
  (when (process-get hara-manage--process 'hara-manage-applying)
    (user-error "Cannot safely cancel a code.manage write"))
  (let ((process hara-manage--process))
    (setq hara-manage--process nil)
    (set-process-sentinel process #'ignore)
    (delete-process process)
    (hara-manage--process-output process)
    (message "Hara manage operation cancelled")))

(defun hara-manage--apply (preview)
  "Verify and apply PREVIEW through a fresh --write invocation."
  (hara-manage--verify-preview preview)
  (hara-manage--save-project-buffers (hara-manage-preview-root preview))
  (hara-manage--verify-preview preview)
  (hara-manage--start-process
   preview t (hara-manage-preview-added preview)))

(defun hara-manage-apply ()
  "Apply the preview displayed in the current Hara manage buffer."
  (interactive)
  (unless (hara-manage-preview-p hara-manage--preview)
    (user-error "This buffer does not contain a Hara manage preview"))
  (when (y-or-n-p
         (format "Apply hara manage %s changes? "
                 (hara-manage-preview-operation hara-manage--preview)))
    (hara-manage--apply hara-manage--preview)))

(defun hara-manage-refresh-preview ()
  "Rerun the operation displayed in the current preview buffer."
  (interactive)
  (unless (hara-manage-preview-p hara-manage--preview)
    (user-error "This buffer does not contain a Hara manage preview"))
  (hara-manage--save-project-buffers (hara-manage-preview-root hara-manage--preview))
  (hara-manage--start-process
   (hara-manage-preview-create
    :operation (hara-manage-preview-operation hara-manage--preview)
    :namespace (hara-manage-preview-namespace hara-manage--preview)
    :root (hara-manage-preview-root hara-manage--preview)
    :added (hara-manage-preview-added hara-manage--preview))))

(defun hara-manage--run (operation &optional added)
  "Preview OPERATION for the current source namespace, with optional ADDED."
  (let ((namespace (hara-manage--buffer-namespace))
        (root (hara-manage--project-root)))
    (hara-manage--save-project-buffers root)
    (hara-manage--start-process
     (hara-manage-preview-create
      :operation operation
      :namespace namespace
      :root root
      :added added))))

;;;###autoload
(defun hara-manage-scaffold (&optional added)
  "Preview scaffold for the current namespace using optional ADDED.
With a prefix argument, prompt for an explicit :added version."
  (interactive
   (list (when current-prefix-arg
           (read-string "Fact :added version: "))))
  (hara-manage--run 'scaffold added))

;;;###autoload
(defun hara-manage-import ()
  "Preview importing fact titles into the current source namespace."
  (interactive)
  (hara-manage--run 'import))

;;;###autoload
(defun hara-manage-purge ()
  "Preview purging source docstrings and :added metadata."
  (interactive)
  (hara-manage--run 'purge))

;;;###autoload
(defun hara-manage-incomplete ()
  "Report missing referenced facts and TODO facts."
  (interactive)
  (hara-manage--run 'incomplete))

;;;###autoload
(defun hara-manage-pedantic ()
  "Report Foundation-compatible M/T/N/C findings."
  (interactive)
  (hara-manage--run 'pedantic))

;;;###autoload
(defun hara-manage-dispatch (operation)
  "Dispatch a code.manage OPERATION with completion."
  (interactive
   (list
    (intern
     (completing-read
      "Hara manage: "
      (mapcar #'symbol-name
              (append hara-manage-editing-operations
                      hara-manage-reporting-operations))
      nil t))))
  (pcase operation
    ('scaffold (call-interactively #'hara-manage-scaffold))
    ('import (hara-manage-import))
    ('purge (hara-manage-purge))
    ('incomplete (hara-manage-incomplete))
    ('pedantic (hara-manage-pedantic))
    (_ (user-error "Unsupported Hara manage operation: %s" operation))))

(defvar hara-manage-prefix-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "s") #'hara-manage-scaffold)
    (define-key map (kbd "i") #'hara-manage-import)
    (define-key map (kbd "p") #'hara-manage-purge)
    (define-key map (kbd "n") #'hara-manage-incomplete)
    (define-key map (kbd "d") #'hara-manage-pedantic)
    (define-key map (kbd "k") #'hara-manage-cancel)
    (define-key map (kbd "m") #'hara-manage-dispatch)
    map)
  "Prefix keymap installed beneath `C-c m'.")

;;;###autoload
(define-minor-mode hara-manage-mode
  "Minor mode for Hara code.manage workflows."
  :lighter " HaraM"
  :keymap (let ((map (make-sparse-keymap)))
            (define-key map (kbd "C-c m") hara-manage-prefix-map)
            map))

(with-eval-after-load 'hara-mode
  (when (boundp 'hara-mode-map)
    (define-key hara-mode-map (kbd "C-c m") hara-manage-prefix-map)))

(provide 'hara-manage)
;;; hara-manage.el ends here
