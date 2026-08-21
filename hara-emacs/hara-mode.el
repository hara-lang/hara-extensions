;;; hara-mode.el --- Hara editing and RESP tooling -*- lexical-binding: t; -*-

;; Package-Requires: ((emacs "29.1"))
;; Version: 0.1.0

;;; Commentary:
;; A dependency-free Hara major mode, protocol-4 client, project launcher, and REPL.

;;; Code:

(require 'cl-lib)
(require 'comint)
(require 'compile)
(require 'easymenu)
(require 'eldoc)
(require 'imenu)
(require 'hara-manage nil t)
(require 'project)
(require 'seq)
(require 'subr-x)
(require 'xref)

(declare-function eldoc-box-help-at-point "eldoc-box")
(declare-function projectile-register-project-type "projectile")
(defvar projectile-project-root-files)
(defvar projectile-project-root-files-bottom-up)

(defgroup hara nil "Hara language tooling." :group 'languages)

(defcustom hara-command
  (or (and (boundp 'load-file-name) load-file-name
           (let ((bin (expand-file-name "bin/hara" (file-name-directory load-file-name))))
             (and (file-executable-p bin) bin)))
      "hara")
  "Hara executable used by `hara-jack-in'.
If you customize this, hara-mode will use your value exactly. Otherwise it
tries to find a package-local `bin/hara' launcher and falls back to a `hara'
executable on `exec-path'."
  :type 'string)

(defun hara--package-bin ()
  "Return the path to the package-local bin/hara launcher, if any."
  (when-let ((file (or (and (boundp 'load-file-name) load-file-name)
                       (locate-library "hara-mode"))))
    (let ((bin (expand-file-name "bin/hara" (file-name-directory file))))
      (and (file-executable-p bin) bin))))

(defun hara--find-in-ancestors (start relative-path)
  "Search upward from START for executable RELATIVE-PATH."
  (let ((dir (file-name-as-directory start))
        found)
    (while (and dir (not found))
      (let ((candidate (expand-file-name relative-path dir)))
        (if (and (file-regular-p candidate)
                 (file-executable-p candidate))
            (setq found candidate)
          (let ((parent (file-name-directory (directory-file-name dir))))
            (setq dir (if (equal parent dir) nil parent))))))
    found))

(defun hara--resolve-command ()
  "Return the executable to use for launching the Hara server.
Prefer, in order:
1. An absolute, executable `hara-command'.
2. A `hara' script in the current project root or its ancestors.
3. A workspace or legacy monorepo hara-emacs launcher.
4. The package-local `bin/hara' wrapper.
5. The raw `hara-command' value."
  (cond
   ((and (file-name-absolute-p hara-command)
         (file-executable-p hara-command))
    hara-command)
   ((when-let ((root (hara--project-file-root)))
      (or (hara--find-in-ancestors root "hara")
          (hara--find-in-ancestors root "extensions/hara-emacs/bin/hara")
          (hara--find-in-ancestors root "apps/hara-emacs/bin/hara"))))
   ((hara--package-bin))
   (t hara-command)))

(defcustom hara-host "127.0.0.1"
  "Configured Hara RESP host."
  :type 'string)

(defcustom hara-port 1311
  "Configured Hara RESP port."
  :type 'integer)

(defcustom hara-auto-start t
  "When non-nil, `hara-connect' launches a server if discovery fails."
  :type 'boolean)

(defcustom hara-auto-jack-in-projects t
  "When non-nil, automatically jack in for files beneath a project.edn.
Standalone Hara files do not trigger a connection."
  :type 'boolean)

(defcustom hara-connect-timeout 3.0
  "Seconds allowed for endpoint negotiation and server startup."
  :type 'number)

(defcustom hara-server-start-timeout 15.0
  "Seconds allowed for a newly launched Hara server to publish its endpoint.
This is longer than `hara-connect-timeout' because a changed runtime may
need one incremental Maven build before its first startup."
  :type 'number)

(defcustom hara-cache-directory
  (locate-user-emacs-file "hara/servers/")
  "Directory holding per-project endpoint records."
  :type 'directory)

(defcustom hara-inline-result-max-length 120
  "Maximum number of characters displayed in an inline result."
  :type 'integer)

(defcustom hara-inline-result-duration 10
  "Seconds before an inline result is removed.
Set this to nil to retain results until the next edit or evaluation."
  :type '(choice (const :tag "Until changed" nil) number))

(defface hara-inline-result-face
  '((((class color) (background light))
     :background "grey90" :box (:line-width -1 :color "yellow"))
    (((class color) (background dark))
     :background "grey10" :box (:line-width -1 :color "black")))
  "Face used for successful inline evaluation results."
  :group 'hara)

(defface hara-inline-error-face
  '((((class color) (background light))
     :background "orange red" :foreground "white" :extend t)
    (((class color) (background dark))
     :background "firebrick" :foreground "white" :extend t))
  "Face used for inline evaluation failures."
  :group 'hara)

(defface hara-inline-fringe-face
  '((t :foreground "green"))
  "Face used for successful evaluation indicators in the fringe."
  :group 'hara)

(defface hara-inline-error-fringe-face
  '((t :foreground "red"))
  "Face used for failed evaluation indicators in the fringe."
  :group 'hara)

(define-error 'hara-resp-incomplete "Incomplete RESP frame")
(define-error 'hara-resp-error "RESP protocol error")

(cl-defstruct (hara-connection (:constructor hara--make-connection))
  root host port process server-process pending counter session namespace instance project
  refs doc-cache repl-buffer)

(defvar hara--connections (make-hash-table :test #'equal))
(defvar hara--namespace-file-cache (make-hash-table :test #'equal))
(defvar-local hara--connection nil)
(defvar-local hara--repl-connection nil)
(defvar-local hara--result-overlay nil)
(defvar-local hara--fringe-overlay nil)
(defvar-local hara--result-timer nil)
(defvar-local hara--eldoc-generation 0)
(defvar-local hara--auto-jack-in-timer nil)

(defun hara--line-end (data start)
  (or (string-match "\r\n" data start)
      (signal 'hara-resp-incomplete nil)))

(defun hara--resp-parse-at (data offset)
  "Parse one RESP value in unibyte DATA at OFFSET.
Return (VALUE . NEXT-OFFSET), or signal `hara-resp-incomplete'."
  (when (>= offset (length data))
    (signal 'hara-resp-incomplete nil))
  (let* ((marker (aref data offset))
         (line-end (and (memq marker '(?+ ?- ?: ?$ ?*))
                        (hara--line-end data (1+ offset))))
         (line (and line-end
                    (decode-coding-string
                     (substring data (1+ offset) line-end) 'utf-8 t)))
         (body (+ (or line-end offset) 2)))
    (pcase marker
      (?+ (cons line body))
      (?- (cons (list :resp-error line) body))
      (?: (unless (string-match-p "\\`-?[0-9]+\\'" line)
            (signal 'hara-resp-error (list "Invalid integer")))
          (cons (string-to-number line) body))
      (?$
       (let ((size (string-to-number line)))
         (cond
          ((= size -1) (cons nil body))
          ((< size -1) (signal 'hara-resp-error (list "Invalid bulk length")))
          ((> (+ body size 2) (length data))
           (signal 'hara-resp-incomplete nil))
          ((not (string= (substring data (+ body size) (+ body size 2)) "\r\n"))
           (signal 'hara-resp-error (list "Missing bulk CRLF")))
          (t
           (cons (decode-coding-string
                  (substring data body (+ body size)) 'utf-8 t)
                 (+ body size 2))))))
      (?*
       (let ((count (string-to-number line)))
         (cond
          ((= count -1) (cons nil body))
          ((< count -1) (signal 'hara-resp-error (list "Invalid array length")))
          (t
           (let ((items nil)
                 (position body))
             (dotimes (_ count)
               (pcase-let ((`(,value . ,next)
                            (hara--resp-parse-at data position)))
                 (push value items)
                 (setq position next)))
             (cons (nreverse items) position))))))
      (_ (signal 'hara-resp-error
                 (list (format "Unknown RESP marker %c" marker)))))))

(defun hara--resp-encode-value (value)
  (cond
   ((null value) "$-1\r\n")
   ((integerp value) (format ":%d\r\n" value))
   ((stringp value)
    (let ((bytes (encode-coding-string value 'utf-8 t)))
      (concat "$" (number-to-string (length bytes)) "\r\n" bytes "\r\n")))
   ((vectorp value)
    (hara--resp-encode-value (append value nil)))
   ((listp value)
    (concat "*" (number-to-string (length value)) "\r\n"
            (mapconcat #'hara--resp-encode-value value "")))
   (t (signal 'hara-resp-error
              (list (format "Cannot encode %S" value))))))

(defun hara--send-value (process value)
  (process-send-string process
                       (encode-coding-string
                        (hara--resp-encode-value value) 'raw-text t)))

(defun hara--flat-response-alist (response)
  (let (result)
    (while response
      (let ((key (pop response))
            (value (pop response)))
        (push (cons (upcase (format "%s" key)) value) result)))
    result))

(defun hara--protocol-version (metadata)
  "Return the numeric protocol version advertised by METADATA.
Accept both the Truffle `PROTO' field and Rust's `PROTOCOL' field."
  (let ((value (or (cdr (assoc "PROTO" metadata))
                   (cdr (assoc "PROTOCOL" metadata)))))
    (if (stringp value) (string-to-number value) value)))

(defun hara--process-filter (process chunk)
  (let ((data (concat (or (process-get process 'hara-buffer) "")
                      (encode-coding-string chunk 'raw-text t)))
        (position 0)
        parsed)
    (condition-case nil
        (while (< position (length data))
          (setq parsed (hara--resp-parse-at data position)
                position (cdr parsed))
          (hara--handle-frame process (car parsed)))
      (hara-resp-incomplete nil)
      (hara-resp-error
       (delete-process process)))
    (process-put process 'hara-buffer (substring data position))))

(defun hara--process-sentinel (process event)
  (unless (process-live-p process)
    (let ((connection (process-get process 'hara-connection)))
      (when connection
        (maphash
         (lambda (_id pending)
           (when-let ((failure (plist-get pending :failure)))
             (funcall failure (string-trim event))))
         (hara-connection-pending connection))
        (clrhash (hara-connection-pending connection))
        (hara--detach-connection connection)
        (when (eq (gethash (hara-connection-root connection) hara--connections)
                  connection)
          (remhash (hara-connection-root connection) hara--connections))))))

(defun hara--handle-frame (process frame)
  (if (not (process-get process 'hara-negotiated))
      (process-put process 'hara-hello frame)
    (let* ((connection (process-get process 'hara-connection))
           (kind (and (listp frame) (car frame)))
           (id (and (listp frame) (cadr frame)))
           (pending (and id
                         (gethash id (hara-connection-pending connection)))))
      (when pending
        (pcase kind
          ("RESULT"
           (setq pending (plist-put pending :result (nth 2 frame)))
           (puthash id pending (hara-connection-pending connection)))
          ("ERROR"
           (setq pending
                 (plist-put pending :error
                            (list (nth 2 frame) (nth 3 frame))))
           (puthash id pending (hara-connection-pending connection)))
          ("DONE"
           (remhash id (hara-connection-pending connection))
           (if-let ((error (plist-get pending :error)))
               (when-let ((failure (plist-get pending :failure)))
                 (funcall failure error))
             (when-let ((success (plist-get pending :success)))
               (funcall success (plist-get pending :result))))))))))

(defun hara--project-root ()
  (file-name-as-directory
   (file-truename
    (or (locate-dominating-file
         default-directory
         "project.edn")
        (when-let ((project (project-current nil)))
          (project-root project))
        default-directory))))

(defun hara--project-file-root ()
  "Return the nearest project.edn root for the current file."
  (when (and buffer-file-name
             (not (file-remote-p buffer-file-name)))
    (when-let ((root (locate-dominating-file
                      (file-name-directory buffer-file-name)
                      "project.edn")))
      (file-name-as-directory (file-truename root)))))

(defun hara--test-command (&optional file)
  "Build the native Hara project test command, optionally focused on FILE."
  (let ((root (hara--project-file-root)))
    (unless root
      (user-error "No project.edn found above the current file"))
    (mapconcat #'shell-quote-argument
               (append (list (hara--resolve-command)
                             "--project" root "--offline" "project" "test")
                       (and file (list (expand-file-name file))))
               " ")))

(defconst hara--source-test-layouts
  '(("lib/src-lang/" . "lib/test-lang/")
    ("lib/src/" . "lib/test/")
    ("src-lang/" . "test-lang/")
    ("src/" . "test/"))
  "Conventional Hara source and test directory pairs.")

(defun hara--source-test-counterpart (file)
  "Return the conventional source or test counterpart for FILE.
The result need not exist.  Return nil when FILE is outside a recognised
Hara source or test layout."
  (when-let ((root (hara--project-file-root)))
    (let ((relative (file-relative-name
                     (if (file-exists-p file)
                         (file-truename file)
                       (expand-file-name file))
                     root))
          counterpart)
      (dolist (layout hara--source-test-layouts)
        (let ((source-root (car layout))
              (test-root (cdr layout)))
          (cond
           ((and (not counterpart) (string-prefix-p source-root relative))
            (let* ((source-relative (substring relative (length source-root)))
                   (extension (file-name-extension source-relative t))
                   (stem (file-name-sans-extension source-relative)))
              (setq counterpart
                    (expand-file-name
                     (concat test-root stem "_test" extension) root))))
           ((and (not counterpart) (string-prefix-p test-root relative))
            (let* ((test-relative (substring relative (length test-root)))
                   (extension (file-name-extension test-relative t))
                   (stem (file-name-sans-extension test-relative)))
              (when (string-suffix-p "_test" stem)
                (setq counterpart
                      (expand-file-name
                       (concat source-root
                               (substring stem 0 (- (length stem) 5))
                               extension)
                       root))))))))
      counterpart)))

(defun hara--focused-test-file (file)
  "Return the focused test target associated with FILE."
  (let ((counterpart (hara--source-test-counterpart file)))
    (if (and counterpart (file-readable-p counterpart)
             (string-match-p "_test\\.hal\\'" counterpart))
        counterpart
      file)))

;;;###autoload
(defun hara-toggle-source-test ()
  "Visit the conventional source or test counterpart of the current file."
  (interactive)
  (unless buffer-file-name
    (user-error "Current buffer has no file"))
  (let ((counterpart (hara--source-test-counterpart buffer-file-name)))
    (unless counterpart
      (user-error "Current file is outside a recognised Hara source/test layout"))
    (unless (file-readable-p counterpart)
      (user-error "No counterpart at %s; scaffold the test first" counterpart))
    (find-file counterpart)))

(defalias 'hara-import #'hara-manage-import)
(defalias 'hara-scaffold #'hara-manage-scaffold)
(defalias 'hara-purge #'hara-manage-purge)

(defun hara-test-file ()
  "Run the current Hara file's focused test in a fresh native process.
When invoked from a source file with an existing conventional test counterpart,
run that test file."
  (interactive)
  (unless buffer-file-name
    (user-error "Current buffer has no file"))
  (save-buffer)
  (let ((target (hara--focused-test-file buffer-file-name)))
    (message "Hara test: %s" (file-relative-name target (hara--project-file-root)))
    (compilation-start (hara--test-command target)
                       'compilation-mode
                       (lambda (_) "*Hara test*"))))

(defun hara-test-project ()
  "Run all tests in the current Hara project."
  (interactive)
  (save-some-buffers t (lambda () (derived-mode-p 'hara-mode)))
  (compilation-start (hara--test-command)
                     'compilation-mode
                     (lambda (_) "*Hara project test*")))

(defun hara-test-rerun ()
  "Rerun the most recent Hara compilation command."
  (interactive)
  (recompile))

(defun hara--auto-jack-in ()
  (setq hara--auto-jack-in-timer nil)
  (when (and hara-auto-jack-in-projects
             (derived-mode-p 'hara-mode)
             (not (and hara--connection
                       (process-live-p
                        (hara-connection-process hara--connection))))
             (hara--project-file-root))
    (condition-case error
        (hara-jack-in)
      (error
       (display-warning
        'hara
        (format "Automatic Hara jack-in failed: %s"
                (error-message-string error))
        :warning)))))

(defun hara--schedule-auto-jack-in ()
  (when (and hara-auto-jack-in-projects
             (hara--project-file-root)
             (not (and hara--connection
                       (process-live-p
                        (hara-connection-process hara--connection))))
             (not (timerp hara--auto-jack-in-timer)))
    (let ((buffer (current-buffer)))
      (setq hara--auto-jack-in-timer
            (run-at-time
             0 nil
             (lambda ()
               (when (buffer-live-p buffer)
                 (with-current-buffer buffer
                   (hara--auto-jack-in)))))))))

(defun hara--cache-file (root)
  (expand-file-name
   (concat (secure-hash 'sha256 (file-truename root)) ".eld")
   hara-cache-directory))

(defun hara--read-cache (root)
  (let ((file (hara--cache-file root)))
    (when (file-readable-p file)
      (condition-case nil
          (with-temp-buffer
            (insert-file-contents file)
            (read (current-buffer)))
        (error nil)))))

(defun hara--write-cache (connection)
  (make-directory hara-cache-directory t)
  (let ((file (hara--cache-file (hara-connection-root connection))))
    (with-temp-file file
      (prin1
       (list :root (hara-connection-root connection)
             :host (hara-connection-host connection)
             :port (hara-connection-port connection)
             :pid (and (hara-connection-server-process connection)
                       (process-id (hara-connection-server-process connection)))
             :instance (hara-connection-instance connection)
             :project (hara-connection-project connection)
             :timestamp (float-time))
       (current-buffer)))))

(defun hara--delete-cache (root)
  (let ((file (hara--cache-file root)))
    (when (file-exists-p file) (delete-file file))))

(defun hara--open-endpoint (root host port &optional expected-instance server-process)
  (let* ((network
          (make-network-process
           :name (format "hara-%s:%d" host port)
           :host host :service port :family 'ipv4
           :coding 'binary :noquery t
           :filter #'hara--process-filter
           :sentinel #'hara--process-sentinel))
         (connection
          (hara--make-connection
           :root root :host host :port port :process network
           :server-process server-process :pending (make-hash-table :test #'equal)
           :counter 0 :session "ROOT" :refs 0
           :doc-cache (make-hash-table :test #'equal))))
    (process-put network 'hara-connection connection)
    (hara--send-value network '("HELLO" "4" "CLIENT" "EMACS"))
    (let ((deadline (+ (float-time) hara-connect-timeout)))
      (while (and (not (process-get network 'hara-hello))
                  (process-live-p network)
                  (< (float-time) deadline))
        (accept-process-output network 0.05)))
    (let* ((hello (process-get network 'hara-hello))
           (metadata (and (listp hello) (hara--flat-response-alist hello)))
           (server (cdr (assoc "SERVER" metadata)))
           (protocol (hara--protocol-version metadata))
           (instance (cdr (assoc "INSTANCE" metadata)))
           (server-project (cdr (assoc "PROJECT" metadata))))
      (unless (and (equal server "HARA") (equal protocol 4))
        (delete-process network)
        (error "Endpoint %s:%d is not a Hara protocol-4 server" host port))
      (when (and expected-instance (not (equal expected-instance instance)))
        (delete-process network)
        (error "Cached Hara endpoint has been replaced"))
      (when (and server-project
                 (not (equal
                       (file-name-as-directory (file-truename server-project))
                       root)))
        (delete-process network)
        (error "Hara endpoint belongs to %s" server-project))
      (setf (hara-connection-instance connection) instance
            (hara-connection-project connection) server-project)
      (process-put network 'hara-negotiated t)
      connection)))

(defun hara--try-endpoint (root host port &optional instance)
  (condition-case nil
      (hara--open-endpoint root host port instance)
    (error nil)))

(defun hara--server-process-filter (server output)
  "Collect SERVER output and detect an endpoint across chunk boundaries."
  (when-let ((buffer (process-buffer server)))
    (with-current-buffer buffer
      (goto-char (point-max))
      (insert output)
      (save-excursion
        (goto-char (point-min))
        (when (re-search-forward
               "HARA RESP \\([^:\n]+\\):\\([0-9]+\\)" nil t)
          (process-put server 'hara-endpoint
                       (cons (match-string 1)
                             (string-to-number (match-string 2)))))))))

(defun hara--start-server (root)
  (let* ((buffer (get-buffer-create
                  (format " *hara-server %s*" (file-name-nondirectory
                                                (directory-file-name root)))))
         (_ (with-current-buffer buffer (erase-buffer)))
         (default-directory root)
         (command (hara--resolve-command))
         (process
          (make-process
           :name (format "hara-server-%s"
                         (substring (secure-hash 'sha1 root) 0 8))
           :buffer buffer
           :command (list command "--project" root "--root" root
                          "--host" "127.0.0.1"
                          "--port" "0" "headless")
           :filter #'hara--server-process-filter
           :coding 'utf-8 :noquery t
           :connection-type 'pipe))
         endpoint)
    (message "Starting Hara server: %s" command)
    (let ((deadline (+ (float-time) hara-server-start-timeout)))
      (while (and (not (setq endpoint (process-get process 'hara-endpoint)))
                  (process-live-p process)
                  (< (float-time) deadline))
        (accept-process-output process 0.05)))
    (unless endpoint
      (when (process-live-p process) (delete-process process))
      (error "Hara server did not publish an endpoint; see %s"
             (buffer-name buffer)))
    (condition-case error
        (hara--open-endpoint root (car endpoint) (cdr endpoint) nil process)
      (error
       (when (process-live-p process) (delete-process process))
       (signal (car error) (cdr error))))))

(defun hara--discover-connection (root)
  (let ((existing (gethash root hara--connections)))
    (unless (and existing
                 (process-live-p (hara-connection-process existing)))
      (when existing (remhash root hara--connections))
      (setq existing nil))
    (or existing
      (let* ((cache (hara--read-cache root))
             (cached
              (and cache
                   (equal (plist-get cache :root) root)
                   (hara--try-endpoint
                    root (plist-get cache :host) (plist-get cache :port)
                    (plist-get cache :instance))))
             (configured
              (or cached (hara--try-endpoint root hara-host hara-port)))
             (connection
              (or configured
                  (and hara-auto-start (hara--start-server root)))))
        (unless connection
          (error "No Hara server found for %s" root))
        (puthash root connection hara--connections)
        (hara--write-cache connection)
        connection))))

;;;###autoload
(defun hara-connect ()
  "Connect the current buffer to its project Hara server."
  (interactive)
  (let* ((root (hara--project-root))
         (connection (hara--discover-connection root)))
    (setq-local hara--connection connection)
    (hara-connected-mode 1)
    (message "Hara connected to %s:%d [%s]"
             (hara-connection-host connection)
             (hara-connection-port connection)
             (hara-connection-session connection))
    connection))

;;;###autoload
(defun hara-jack-in ()
  "Connect to, or launch, the current project Hara server."
  (interactive)
  (let ((hara-auto-start t))
    (hara-connect)))

(defun hara--disconnect (connection)
  (when (process-live-p (hara-connection-process connection))
    (delete-process (hara-connection-process connection)))
  (when-let ((server (hara-connection-server-process connection)))
    (when (process-live-p server) (delete-process server)))
  (hara--delete-cache (hara-connection-root connection))
  (remhash (hara-connection-root connection) hara--connections))

(defun hara--detach-connection (connection)
  "Detach CONNECTION from every Hara source and REPL buffer."
  (dolist (buffer (buffer-list))
    (with-current-buffer buffer
      (when (eq hara--connection connection)
        (when (bound-and-true-p hara-connected-mode)
          (hara-connected-mode -1))
        (setq-local hara--connection nil))
      (when (eq hara--repl-connection connection)
        (setq-local hara--repl-connection nil)))))

;;;###autoload
(defun hara-interrupt ()
  "Recover from an evaluation that cannot be interrupted by the server.
Stop an Emacs-owned server; otherwise close only the client connection."
  (interactive)
  (let ((connection (or hara--connection
                        (gethash (hara--project-root) hara--connections))))
    (unless connection (user-error "No Hara connection"))
    (let ((owned (and (hara-connection-server-process connection)
                      (process-live-p
                       (hara-connection-server-process connection)))))
      (maphash
       (lambda (_id pending)
         (when-let ((failure (plist-get pending :failure)))
           (funcall failure '("INTERRUPTED" "Hara evaluation interrupted"))))
       (hara-connection-pending connection))
      (clrhash (hara-connection-pending connection))
      (hara--detach-connection connection)
      (hara--disconnect connection)
      (message (if owned
                   "Hara evaluation interrupted; server stopped—jack in again"
                 "Hara client disconnected; external server was left running")))))

;;;###autoload
(defun hara-disconnect ()
  "Disconnect the current project and stop an Emacs-owned server."
  (interactive)
  (let ((connection (or hara--connection
                        (gethash (hara--project-root) hara--connections))))
    (unless connection (user-error "No Hara connection"))
    (hara--detach-connection connection)
    (when (gethash (hara-connection-root connection) hara--connections)
      (hara--disconnect connection))
    (message "Hara disconnected")))

(defun hara--connection ()
  (unless (and hara--connection
               (process-live-p (hara-connection-process hara--connection)))
    (setq-local hara--connection nil))
  (or hara--connection (hara-connect)))

(defun hara--next-id (connection)
  (setf (hara-connection-counter connection)
        (1+ (hara-connection-counter connection)))
  (format "EMACS-%d" (hara-connection-counter connection)))

(defun hara--request (connection operation arguments success &optional failure)
  (let* ((id (hara--next-id connection))
         (success-callback
          (if (member operation '("EVAL" "SESSION"))
              (lambda (value)
                (hara--invalidate-doc-cache connection)
                (funcall success value))
            success)))
    (puthash id (list :success success-callback
                      :failure (or failure #'hara--show-error))
             (hara-connection-pending connection))
    (hara--send-value
     (hara-connection-process connection)
     (append (list operation id) arguments))
    id))

(defun hara--invalidate-doc-cache (connection)
  (when-let ((cache (hara-connection-doc-cache connection)))
    (clrhash cache)))

(defun hara--request-sync (connection operation arguments)
  (let (done result error)
    (hara--request connection operation arguments
                   (lambda (value) (setq result value done t))
                   (lambda (value) (setq error value done t)))
    (let ((deadline (+ (float-time) hara-connect-timeout)))
      (while (and (not done)
                  (process-live-p (hara-connection-process connection))
                  (< (float-time) deadline))
        (accept-process-output (hara-connection-process connection) 0.05)))
    (unless done (error "Hara request timed out"))
    (when error (error "Hara %s: %s" (car error) (cadr error)))
    result))

(defun hara--show-error (error)
  (with-current-buffer (get-buffer-create "*Hara Error*")
    (let ((inhibit-read-only t))
      (erase-buffer)
      (insert (format "Hara %s\n\n%s\n" (car error) (cadr error)))
      (special-mode))
    (display-buffer (current-buffer))))

(defun hara--clear-result-overlay (&rest _)
  (remove-hook 'post-command-hook #'hara--clear-result-overlay t)
  (remove-hook 'post-command-hook #'hara--arm-result-clear t)
  (when (timerp hara--result-timer)
    (cancel-timer hara--result-timer))
  (setq hara--result-timer nil)
  (when (overlayp hara--result-overlay)
    (delete-overlay hara--result-overlay))
  (when (overlayp hara--fringe-overlay)
    (delete-overlay hara--fringe-overlay))
  (setq hara--result-overlay nil
        hara--fringe-overlay nil))

(defun hara--arm-result-clear ()
  "Arrange for the current result to disappear after the next command."
  (remove-hook 'post-command-hook #'hara--arm-result-clear t)
  (add-hook 'post-command-hook #'hara--clear-result-overlay nil t))

(defun hara--schedule-result-clear ()
  (remove-hook 'post-command-hook #'hara--clear-result-overlay t)
  (remove-hook 'post-command-hook #'hara--arm-result-clear t)
  (if this-command
      (add-hook 'post-command-hook #'hara--arm-result-clear nil t)
    (hara--arm-result-clear)))

(defun hara--fontify-result (value)
  (with-temp-buffer
    (delay-mode-hooks (hara-mode))
    (insert (format "%s" value))
    (font-lock-ensure)
    (buffer-substring (point-min) (point-max))))

(defun hara--result-start (marker)
  (save-excursion
    (goto-char marker)
    (skip-chars-backward "\r\n[:blank:]")
    (condition-case nil
        (progn (backward-sexp) (point))
      (error (line-beginning-position)))))

(defun hara--result-display-string (value face)
  (let* ((fontified (hara--fontify-result value))
         (display (concat "  => " fontified " "))
         (width (max 20 (window-width)))
         (threshold (max hara-inline-result-max-length (* 3 width))))
    (when (> (length display) threshold)
      (setq display
            (concat (substring display 0 threshold)
                    "…\nResult truncated; see the project Hara REPL for the full value.")))
    (add-face-text-property 0 (length display) face nil display)
    (put-text-property 0 1 'cursor 0 display)
    display))

(defun hara--result-face (type)
  "Return the Hara result face for TYPE."
  (pcase type
    ('error 'hara-inline-error-face)
    (_ 'hara-inline-result-face)))

(defun hara--display-inline (marker value face)
  (when (and (markerp marker) (marker-buffer marker))
    (with-current-buffer (marker-buffer marker)
      (hara--clear-result-overlay)
      (save-excursion
        (goto-char marker)
        (skip-chars-backward "\r\n[:blank:]")
        (let* ((begin (hara--result-start (point)))
               (end (line-end-position))
               (display (hara--result-display-string value face))
               (remaining (- (window-width) (current-column))))
          (when (or (string-match-p "\n." display)
                    (> (string-width display) remaining))
            (setq display (concat " \n" display)))
          (let ((overlay (make-overlay begin end nil t t))
                (fringe (make-overlay begin begin nil t t)))
            (overlay-put overlay 'hara-result t)
            (overlay-put overlay 'after-string display)
            (overlay-put fringe 'hara-fringe t)
            (overlay-put
             fringe 'before-string
             (propertize " " 'display
                         `(left-fringe empty-line
                                       ,(if (eq face 'hara-inline-error-face)
                                            'hara-inline-error-fringe-face
                                          'hara-inline-fringe-face))))
            (setq hara--result-overlay overlay
                  hara--fringe-overlay fringe))))
      (hara--schedule-result-clear)
      (when hara-inline-result-duration
        (let ((buffer (current-buffer)))
          (setq hara--result-timer
                (run-at-time
                 hara-inline-result-duration nil
                 (lambda ()
                   (when (buffer-live-p buffer)
                     (with-current-buffer buffer
                       (hara--clear-result-overlay)))))))))))

(defun hara--display-result (connection value &optional marker)
  (message "=> %s" value)
  (when marker
    (hara--display-inline marker value (hara--result-face 'result)))
  (when-let ((buffer (hara-connection-repl-buffer connection)))
    (when (buffer-live-p buffer)
      (with-current-buffer buffer
        (when (eq hara--repl-connection connection)
          (hara--repl-insert (format "=> %s\n" value)))))))

(defun hara--source-arguments (source start)
  (let ((arguments (list source)))
    (if (and buffer-file-name start)
        (save-excursion
          (goto-char start)
          (append arguments
                  (list "FILE" (file-truename buffer-file-name)
                        "LINE" (number-to-string (line-number-at-pos))
                        "COLUMN" (number-to-string (1+ (current-column))))))
      arguments)))

(defun hara--buffer-namespace-context ()
  "Return the current buffer's namespace name, source, and starting point."
  (save-excursion
    (goto-char (point-min))
    (let ((case-fold-search nil))
      (when (re-search-forward
             "^[[:space:]]*(ns\\(?:+\\)?[[:space:]\n]+\\([^][(){}[:space:]]+\\)"
             nil t)
        (let* ((name (string-trim (match-string-no-properties 1)))
               (start (match-beginning 0))
               (open (save-excursion
                       (goto-char start)
                       (search-forward "(" nil t)
                       (1- (point))))
               (end (and open (ignore-errors (scan-sexps open 1)))))
          (when end
            (list :name name
                  :source (buffer-substring-no-properties open end)
                  :start open)))))))

(defun hara--eval-in-buffer-namespace
    (connection arguments success failure)
  "Evaluate ARGUMENTS after synchronising CONNECTION to this buffer's namespace."
  (let ((context (hara--buffer-namespace-context)))
    (if (or (null context)
            (equal (plist-get context :name)
                   (hara-connection-namespace connection)))
        (hara--request connection "EVAL" arguments success failure)
      (let ((namespace (plist-get context :name))
            (namespace-arguments
             (hara--source-arguments (plist-get context :source)
                                     (plist-get context :start))))
        (hara--request
         connection "EVAL" namespace-arguments
         (lambda (_)
           (setf (hara-connection-namespace connection) namespace)
           (hara--request connection "EVAL" arguments success failure))
         failure)))))

(defun hara--eval (source &optional start end)
  (let* ((connection (hara--connection))
         (arguments (hara--source-arguments source start))
         (marker (and end (copy-marker end t))))
    (hara--clear-result-overlay)
    (hara--eval-in-buffer-namespace
     connection arguments
     (lambda (value)
       (hara--display-result connection value marker)
       (when (markerp marker) (set-marker marker nil)))
     (lambda (error)
       (hara--show-error error)
       (hara--display-inline
        marker (format "%s: %s" (car error) (cadr error))
        (hara--result-face 'error))
       (when (markerp marker) (set-marker marker nil))))))

;;;###autoload
(defun hara-eval-region (start end)
  "Evaluate the active region."
  (interactive "r")
  (hara--eval (buffer-substring-no-properties start end) start end))

;;;###autoload
(defun hara-eval-buffer ()
  "Evaluate the current buffer."
  (interactive)
  (hara-eval-region (point-min) (point-max)))

(defun hara--last-sexp-bounds ()
  "Return (START . END) of the form preceding point.
When point is inside or before a symbol, the symbol is completed first
so a partial name is never evaluated."
  (cons (save-excursion
          (skip-syntax-forward "w_")
          (backward-sexp)
          (point))
        (save-excursion
          (skip-syntax-forward "w_")
          (point))))

;;;###autoload
(defun hara-eval-last-sexp ()
  "Evaluate the form preceding point."
  (interactive)
  (let ((bounds (hara--last-sexp-bounds)))
    (hara-eval-region (car bounds) (cdr bounds))))

;;;###autoload
(defun hara-eval-last-sexp-and-insert ()
  "Evaluate the form preceding point and insert its result at point."
  (interactive)
  (let ((bounds (hara--last-sexp-bounds))
        (insertion-point (point))
        (buffer (current-buffer)))
    (let ((connection (hara--connection)))
      (hara--eval-in-buffer-namespace
       connection
       (hara--source-arguments
        (buffer-substring-no-properties (car bounds) (cdr bounds))
        (car bounds))
       (lambda (value)
         (when (buffer-live-p buffer)
           (with-current-buffer buffer
             (save-excursion
               (goto-char insertion-point)
               (insert value)))))
       (lambda (error)
         (hara--show-error error))))))

;;;###autoload
(defun hara-eval-defun ()
  "Evaluate the current top-level form."
  (interactive)
  (save-excursion
    (end-of-defun)
    (let ((end (point)))
      (beginning-of-defun)
      (hara-eval-region (point) end))))

(defconst hara--static-completions
  '("->" "->>" "as->" "case" "catch" "cond" "cond->" "cond->>" "declare"
    "def" "def-" "defenum" "defmacro" "defmethod" "defmulti" "defn" "defn-"
    "defprotocol" "defrecord" "defstruct" "deftype" "do" "doseq" "false"
    "finally" "fn" "for" "if" "if-let" "if-not" "if-some" "in-ns" "let"
    "loop" "new" "nil" "ns" "ns+" "protocol" "quote" "recur" "require"
    "some->" "some->>" "syntax-quote" "throw" "true" "try" "when" "when-let"
    "when-not" "while" "with-local-vars" "with-open" "with-redefs"))

(defun hara--normalize-completions (value)
  (cond
   ((stringp value) (split-string value "\n" t "[[:space:]]+"))
   ((listp value) (seq-filter #'stringp value))
   (t nil)))

(defun hara--completion-candidates (value prefix)
  (let ((candidates (append (hara--normalize-completions value)
                            hara--static-completions)))
    (sort (delete-dups
           (seq-filter (lambda (candidate) (string-prefix-p prefix candidate))
                       candidates))
          #'string-lessp)))

(defun hara--completion-annotation (candidate)
  (cond
   ((member candidate '("nil" "true" "false")) " constant")
   ((member candidate hara--static-completions) " form")
   (t
    (when-let* ((connection hara--connection)
                (cache (hara-connection-doc-cache connection))
                (value (gethash candidate cache))
                (signature (hara--format-signatures value)))
      (unless (string-empty-p signature)
        (concat " " signature))))))

(defun hara-completion-at-point ()
  (unless (nth 8 (syntax-ppss))
    (let* ((end (point))
           (start (save-excursion
                    (skip-syntax-backward "w_")
                    (point)))
           (prefix (buffer-substring-no-properties start end))
           (connection (and hara--connection
                            (process-live-p
                             (hara-connection-process hara--connection))
                            hara--connection))
           runtime)
      (when connection
        (condition-case error
            (setq runtime
                  (hara--request-sync connection "COMPLETE" (list prefix)))
          (error
           (message "Hara runtime completion unavailable: %s"
                    (error-message-string error)))))
      (list start end (hara--completion-candidates runtime prefix)
            :annotation-function #'hara--completion-annotation
            :exclusive 'no))))

(defun hara--symbol-at-point ()
  (let ((start (save-excursion
                 (skip-syntax-backward "w_")
                 (point)))
        (end (save-excursion
               (skip-syntax-forward "w_")
               (point))))
    (unless (= start end)
      (buffer-substring-no-properties start end))))

(defun hara--doc-get (value key)
  (let ((tail value)
        result)
    (while tail
      (when (equal (car tail) key)
        (setq result (cadr tail)
              tail nil))
      (when tail (setq tail (cddr tail))))
    result))

(defun hara--request-doc (symbol success &optional failure)
  (let* ((connection (hara--connection))
         (cache (or (hara-connection-doc-cache connection)
                    (setf (hara-connection-doc-cache connection)
                          (make-hash-table :test #'equal))))
         (cached (gethash symbol cache 'hara--missing)))
    (if (not (eq cached 'hara--missing))
        (funcall success cached)
      (hara--request
       connection "DOC" (list symbol)
       (lambda (value)
         (puthash symbol value cache)
         (funcall success value))
       failure))))

(defun hara--request-doc-sync (symbol)
  (let* ((connection (hara--connection))
         (cache (or (hara-connection-doc-cache connection)
                    (setf (hara-connection-doc-cache connection)
                          (make-hash-table :test #'equal))))
         (cached (gethash symbol cache 'hara--missing)))
    (if (not (eq cached 'hara--missing))
        cached
      (let ((value (hara--request-sync connection "DOC" (list symbol))))
        (puthash symbol value cache)
        value))))

(defun hara--format-arglist (arglist)
  (cond
   ((stringp arglist) arglist)
   ((listp arglist)
    (concat "[" (mapconcat (lambda (item) (format "%s" item)) arglist " ") "]"))
   (t (format "%s" arglist))))

(defun hara--format-signatures (value)
  (let ((symbol (or (hara--doc-get value "SYMBOL") ""))
        (arglists (hara--doc-get value "ARGLISTS")))
    (if (consp arglists)
        (mapconcat (lambda (args)
                     (concat symbol " " (hara--format-arglist args)))
                   arglists "  ")
      symbol)))

(defun hara-eldoc-function (callback &rest _ignored)
  "Asynchronously provide Hara documentation to ElDoc."
  (when (and hara--connection
             (process-live-p (hara-connection-process hara--connection)))
    (when-let ((symbol (hara--symbol-at-point)))
      (let ((buffer (current-buffer))
            (generation (cl-incf hara--eldoc-generation)))
        (hara--request-doc
         symbol
         (lambda (value)
           (when (buffer-live-p buffer)
             (with-current-buffer buffer
               (when (and (= generation hara--eldoc-generation)
                          (equal symbol (hara--symbol-at-point)))
                 (let* ((signature (hara--format-signatures value))
                        (doc (hara--doc-get value "DOC"))
                        (summary (and (stringp doc)
                                      (car (split-string doc "\n")))))
                   (funcall callback
                            (if (and summary (not (string-empty-p summary)))
                                (concat signature " — " summary)
                              signature)
                            :thing symbol))))))
         (lambda (_error)
           (when (and (buffer-live-p buffer)
                      (= generation hara--eldoc-generation))
             (funcall callback nil))))
        t))))

;;;###autoload
(defun hara-doc (symbol)
  "Show documentation for SYMBOL."
  (interactive (list (or (hara--symbol-at-point)
                         (read-string "Hara symbol: "))))
  (hara--request-doc
   symbol
   (lambda (value)
     (with-current-buffer (get-buffer-create "*Hara Doc*")
       (let ((inhibit-read-only t))
         (erase-buffer)
         (insert (propertize (hara--format-signatures value)
                             'face 'font-lock-function-name-face)
                 "\n\n")
         (if-let ((doc (hara--doc-get value "DOC")))
             (insert doc "\n")
           (insert "No documentation available.\n"))
         (when-let ((file (hara--doc-get value "FILE")))
           (insert (format "\nDefined at %s:%s:%s\n"
                           file
                           (or (hara--doc-get value "LINE") 1)
                           (or (hara--doc-get value "COLUMN") 1))))
         (help-mode))
       (display-buffer (current-buffer))))))

(defun hara-doc-popup ()
  "Display Hara documentation at point using eldoc-box."
  (interactive)
  (unless (require 'eldoc-box nil t)
    (user-error "Install the eldoc-box package first"))
  (eldoc-box-help-at-point))

(defun hara--xref-backend ()
  'hara)

(cl-defmethod xref-backend-identifier-at-point ((_backend (eql hara)))
  (hara--symbol-at-point))

(defun hara--namespace-alias (alias)
  "Return the namespace assigned to ALIAS in the current buffer."
  (save-excursion
    (goto-char (point-min))
    (when (re-search-forward
           (format "\\[\\([^][(){}[:space:]]+\\)[[:space:]\n]+:as[[:space:]\n]+%s\\(?:[[:space:]\n]\\|\\]\\)"
                   (regexp-quote alias))
           nil t)
      (match-string-no-properties 1))))

(defun hara--namespace-file (root namespace)
  "Find NAMESPACE's local Hara source beneath ROOT."
  (let* ((key (cons root namespace))
         (cached (gethash key hara--namespace-file-cache))
         (relative (concat
                    (replace-regexp-in-string
                     "-" "_" (replace-regexp-in-string "\\." "/" namespace))
                    ".hal")))
    (if (and cached (file-readable-p cached))
        cached
      (let* ((source-roots '("src" "src-lang" "lib/src" "lib/src-lang"
                             "test" "test-lang" "lib/test" "lib/test-lang"))
             (file (cl-loop for source-root in source-roots
                            for candidate = (expand-file-name
                                             relative
                                             (expand-file-name source-root root))
                            when (file-readable-p candidate) return candidate))
             (file (or file
                       (cl-find-if
                        (lambda (candidate)
                          (string-suffix-p relative candidate))
                        (directory-files-recursively
                         root
                         (concat (regexp-quote (file-name-nondirectory relative))
                                 "\\'"))))))
        (when file (puthash key file hara--namespace-file-cache))
        file))))

(defun hara--local-definition (identifier)
  "Return a local xref for IDENTIFIER, or nil when it cannot be found."
  (let* ((parts (split-string identifier "/"))
         (qualified (> (length parts) 1))
         (prefix (and qualified (mapconcat #'identity (butlast parts) "/")))
         (name (car (last parts)))
         (namespace (and prefix (or (hara--namespace-alias prefix) prefix)))
         (root (hara--project-root))
         (file (if namespace
                   (hara--namespace-file root namespace)
                 buffer-file-name)))
    (when (and file (file-readable-p file))
      (with-temp-buffer
        (insert-file-contents file)
        (goto-char (point-min))
        (when (re-search-forward
               (format
                "^(\\(?:declare\\|def-?\\|defenum\\|defmacro\\|defmethod\\|defmulti\\|defn-?\\|defprotocol\\|defrecord\\|defstruct\\|deftype\\)[[:space:]\n]+%s\\(?:[[:space:]\n()\\[]\\|$\\)"
                (regexp-quote name))
               nil t)
          (xref-make identifier
                     (xref-make-file-location
                      file (line-number-at-pos (match-beginning 0)) 0)))))))

(defun hara--clear-namespace-file-cache ()
  "Clear cached project namespace locations after source generation."
  (clrhash hara--namespace-file-cache))

(with-eval-after-load 'hara-manage
  (add-hook 'hara-manage-after-write-hook #'hara--clear-namespace-file-cache))

(cl-defmethod xref-backend-definitions ((_backend (eql hara)) identifier)
  (if-let ((local (hara--local-definition identifier)))
      (list local)
    (let* ((value (hara--request-doc-sync identifier))
           (file (hara--doc-get value "FILE"))
           (line (hara--doc-get value "LINE"))
           (column (hara--doc-get value "COLUMN")))
      (unless (and (stringp file) (not (string-empty-p file)) line)
        (user-error "Hara symbol has no source definition: %s" identifier))
      (unless (file-name-absolute-p file)
        (setq file (expand-file-name file
                                     (hara-connection-root (hara--connection)))))
      (list (xref-make identifier
                       (xref-make-file-location
                        file
                        (if (numberp line) line (string-to-number line))
                        (max 0 (1- (if (numberp column)
                                      column
                                    (string-to-number (or column "1")))))))))))

(defconst hara-imenu-generic-expression
  '(("Definitions"
     "^(\\(?:declare\\|def-?\\|defenum\\|defmacro\\|defmethod\\|defmulti\\|defn-?\\|defprotocol\\|defrecord\\|defstruct\\|deftype\\)\\s-+\\([^][(){}[:space:]]+\\)"
     1)))

;;;###autoload
(defun hara-switch-session ()
  "Attach the current connection to a selected session."
  (interactive)
  (let* ((connection (hara--connection))
         (sessions (hara--request-sync connection "SESSION" '("LIST")))
         (selected (completing-read "Hara session: " sessions nil t nil nil
                                    (hara-connection-session connection))))
    (hara--request
     connection "SESSION" (list "ATTACH" selected)
     (lambda (_)
       (setf (hara-connection-session connection) selected
             (hara-connection-namespace connection) nil)
       (force-mode-line-update t)
       (message "Hara session: %s" selected)))))

;;;###autoload
(defun hara-create-session (name)
  "Create session NAME."
  (interactive "sNew Hara session: ")
  (hara--request (hara--connection) "SESSION" (list "NEW" name)
                 (lambda (_) (message "Created Hara session %s" name))))

;;;###autoload
(defun hara-close-session (name)
  "Close session NAME."
  (interactive
   (let* ((connection (hara--connection))
          (sessions (delete "ROOT"
                            (hara--request-sync connection "SESSION" '("LIST")))))
     (list (completing-read "Close Hara session: " sessions nil t))))
  (hara--request (hara--connection) "SESSION" (list "CLOSE" name)
                 (lambda (_) (message "Closed Hara session %s" name))))

(defun hara--repl-insert (text)
  (let ((inhibit-read-only t)
        (process (get-buffer-process (current-buffer))))
    (goto-char (process-mark process))
    (insert text)
    (set-marker (process-mark process) (point))
    (goto-char (point-max))))

(defun hara--repl-input-sender (_process input)
  (let ((connection hara--repl-connection)
        (buffer (current-buffer)))
    (hara--request
     connection "EVAL" (list input)
     (lambda (value)
       (setf (hara-connection-namespace connection) nil)
       (when (buffer-live-p buffer)
         (with-current-buffer buffer
           (hara--repl-insert (format "=> %s\n[%s] "
                                      value
                                      (hara-connection-session connection))))))
     (lambda (error)
       (when (buffer-live-p buffer)
         (with-current-buffer buffer
           (hara--repl-insert
            (format "ERROR %s: %s\n[%s] "
                    (car error) (cadr error)
                    (hara-connection-session connection)))))))))

(define-derived-mode hara-repl-mode comint-mode "Hara-REPL"
  "Comint mode for a Hara RESP session."
  (setq-local comint-prompt-regexp "^\\[[^]]+\\] ")
  (setq-local comint-input-sender #'hara--repl-input-sender))

(defun hara--repl-buffer (connection)
  "Return CONNECTION's project-specific REPL buffer."
  (let ((existing (hara-connection-repl-buffer connection)))
    (if (buffer-live-p existing)
        existing
      (let* ((project (file-name-nondirectory
                       (directory-file-name (hara-connection-root connection))))
             (buffer (get-buffer-create
                      (generate-new-buffer-name
                       (format "*Hara REPL %s*" project)))))
        (setf (hara-connection-repl-buffer connection) buffer)
        buffer))))

;;;###autoload
(defun hara-repl ()
  "Open the REPL for the current project connection."
  (interactive)
  (let* ((connection (hara--connection))
         (process (hara-connection-process connection))
         (buffer (hara--repl-buffer connection)))
    (set-process-buffer process buffer)
    (with-current-buffer buffer
      (unless (derived-mode-p 'hara-repl-mode)
        (hara-repl-mode)
        (setq-local default-directory (hara-connection-root connection))
        (setq-local hara--repl-connection connection)
        (let ((inhibit-read-only t))
          (erase-buffer)
          (insert (format "Hara %s:%d\n[%s] "
                          (hara-connection-host connection)
                          (hara-connection-port connection)
                          (hara-connection-session connection)))
          (set-marker (process-mark process) (point)))))
    (pop-to-buffer buffer)))

(defvar hara-mode-syntax-table
  (let ((table (make-syntax-table)))
    (modify-syntax-entry ?\; "<" table)
    (modify-syntax-entry ?\n ">" table)
    (modify-syntax-entry ?\" "\"" table)
    ;; Hara symbol constituents beyond word characters.
    (dolist (char (string-to-list "-_*+!?<>=/.:&%$"))
      (modify-syntax-entry char "_" table))
    table))

(defconst hara--language-forms
  '("." "->" "->>" "as->" "case" "catch" "cond" "cond->" "cond->>"
    "declare" "def" "def-" "defenum" "defmacro" "defmethod" "defmulti" "defn"
    "defn-" "defprotocol" "defrecord" "defstruct" "deftype" "do" "doseq"
    "finally" "fn" "for" "if" "if-let" "if-not" "if-some" "in-ns" "let"
    "loop" "new" "ns" "ns+" "protocol" "quote" "recur" "require" "some->"
    "some->>" "syntax-quote" "throw" "try" "when" "when-let" "when-not"
    "while" "with-local-vars" "with-open" "with-redefs"))

(defconst hara-font-lock-keywords
  `((,(regexp-opt hara--language-forms 'symbols) . font-lock-keyword-face)
    (,(regexp-opt '("nil" "true" "false") 'symbols) . font-lock-constant-face)
    ("\\_<::?\\(?:\\sw\\|\\s_\\)+\\_>" . font-lock-constant-face)
    ("\\_<\\*\\(?:\\sw\\|\\s_\\)+\\*\\_>" . font-lock-variable-name-face)
    ("(\\(?:defn-?\\|defmacro\\|defmulti\\|defmethod\\)\\s-+\\(\\(?:\\sw\\|\\s_\\)+\\)"
     1 font-lock-function-name-face)
    ("(\\(?:def-?\\|declare\\)\\s-+\\(\\(?:\\sw\\|\\s_\\)+\\)"
     1 font-lock-variable-name-face)
    ("(\\(?:defenum\\|defprotocol\\|defrecord\\|defstruct\\|deftype\\)\\s-+\\(\\(?:\\sw\\|\\s_\\)+\\)"
     1 font-lock-type-face)))

(defvar hara-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-j") #'hara-jack-in)
    (define-key map (kbd "C-c C-b") #'hara-interrupt)
    (define-key map (kbd "C-c C-z") #'hara-repl)
    (define-key map (kbd "C-c C-e") #'hara-eval-last-sexp)
    (define-key map (kbd "C-c C-i") #'hara-eval-last-sexp-and-insert)
    (define-key map (kbd "C-c C-c") #'hara-eval-defun)
    (define-key map (kbd "C-c C-r") #'hara-eval-region)
    (define-key map (kbd "C-c C-k") #'hara-eval-buffer)
    (define-key map (kbd "C-c C-d") #'hara-doc)
    (define-key map (kbd "C-c C-p") #'hara-doc-popup)
    (define-key map (kbd "C-c C-t") #'hara-test-file)
    (define-key map (kbd "C-c C-a") #'hara-test-project)
    (define-key map (kbd "C-c C-o") #'hara-toggle-source-test)
    (define-key map (kbd "M-.") #'xref-find-definitions)
    map))

(easy-menu-define hara-mode-menu hara-mode-map
  "Menu for Hara source buffers."
  '("Hara"
    ["Import test metadata" hara-manage-import t]
    ["Scaffold tests" hara-manage-scaffold t]
    ["Purge imported metadata" hara-manage-purge t]
    "---"
    ["Test file" hara-test-file t]
    ["Test project" hara-test-project t]
    ["Rerun tests" hara-test-rerun t]
    ["Toggle source/test" hara-toggle-source-test t]
    "---"
    ["Jack in" hara-jack-in t]
    ["Interrupt evaluation" hara-interrupt t]
    ["REPL" hara-repl t]))

;;;###autoload
(define-derived-mode hara-mode prog-mode "Hara"
  "Major mode for Hara source."
  :syntax-table hara-mode-syntax-table
  (setq-local font-lock-defaults '(hara-font-lock-keywords))
  (setq-local comment-start ";")
  (setq-local comment-end "")
  (setq-local indent-line-function #'lisp-indent-line)
  (setq-local imenu-generic-expression hara-imenu-generic-expression)
  (add-hook 'completion-at-point-functions #'hara-completion-at-point nil t)
  (add-hook 'eldoc-documentation-functions #'hara-eldoc-function nil t)
  (add-hook 'xref-backend-functions #'hara--xref-backend nil t)
  (add-hook 'after-change-functions #'hara--clear-result-overlay nil t)
  (eldoc-mode 1)
  (hara--schedule-auto-jack-in))

(define-minor-mode hara-connected-mode
  "Show and manage the current Hara project connection."
  :lighter (:eval
            (when hara--connection
              (format " Hara[%s]" (hara-connection-session hara--connection))))
  (if hara-connected-mode
      (when hara--connection
        (cl-incf (hara-connection-refs hara--connection))
        (add-hook 'kill-buffer-hook
                  (lambda () (hara-connected-mode -1)) nil t))
    (when hara--connection
      (setf (hara-connection-refs hara--connection)
            (max 0 (1- (hara-connection-refs hara--connection)))))))

;;;###autoload
(add-to-list 'auto-mode-alist '("\\.hal\\'" . hara-mode))

;;;###autoload
(with-eval-after-load 'projectile
  (add-to-list 'projectile-project-root-files "project.edn")
  (add-to-list 'projectile-project-root-files-bottom-up "project.edn")
  (projectile-register-project-type
   'hara '("project.edn")
   :src-dir "src/"
   :test-dir "test/"
   :test-suffix "_test"))

(provide 'hara-mode)
;;; hara-mode.el ends here
