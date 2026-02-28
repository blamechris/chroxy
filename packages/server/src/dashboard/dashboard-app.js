
(function() {
  "use strict";

  // ---- Config ----
  var config = window.__CHROXY_CONFIG__;
  var port = config.port;
  var token = config.token;

  // ---- State ----
  var ws = null;
  var connected = false;
  var isReplay = false;
  var sessions = [];
  var activeSessionId = null;
  var activeModel = null;
  var availableModels = [];
  var permissionMode = "approve";
  var isBusy = false;
  var streamingMsgId = null;
  var claudeReady = false;
  var userScrolledUp = false;
  var reconnectTimer = null;
  var reauthRequired = false;
  var RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000];
  var MAX_RETRIES = 8;
  var reconnectAttempt = 0;
  var statusCost = 0;
  var statusContext = "";
  var statusModel = "";
  var backgroundAgents = new Map();
  var inPlanMode = false;
  var modalOpen = false;
  var hadInitialConnect = false;

  // ---- localStorage persistence ----
  var STORAGE_PREFIX = "chroxy_";
  var MAX_STORED_MESSAGES = 100;
  var MAX_ENTRY_SIZE = 50000;
  var persistTimer = null;
  var messageLog = [];
  var restoredFromCache = false;
  var activeCountdowns = [];

  // ---- Analytics state ----
  var costEvents = [];
  var COST_EVENTS_MAX = 500;
  var COST_STORAGE_KEY = STORAGE_PREFIX + "cost_events";
  var sessionCost = 0;
  var totalCost = 0;
  var costBudget = null;

  // ---- Terminal state ----
  var currentView = "chat";
  var term = null;
  var fitAddon = null;
  var terminalBuffer = "";
  var TERMINAL_BUFFER_MAX = 102400;
  var serverMode = null;
  var CLIENT_PROTOCOL_VERSION = 1;
  var serverProtocolVersion = null;

  // ---- DOM refs ----
  var messagesEl = document.getElementById("chat-messages");
  var inputEl = document.getElementById("message-input");
  var sendBtn = document.getElementById("send-btn");
  var interruptBtn = document.getElementById("interrupt-btn");
  var statusDot = document.getElementById("connection-status");
  var reconnectBanner = document.getElementById("reconnect-banner");
  var reconnectText = document.getElementById("reconnect-text");
  var reconnectRetryBtn = document.getElementById("reconnect-retry-btn");
  var reauthContainer = document.getElementById("reauth-container");
  var reauthInput = document.getElementById("reauth-input");
  var reauthSubmitBtn = document.getElementById("reauth-submit-btn");
  var modelSelect = document.getElementById("model-select");
  var permissionSelect = document.getElementById("permission-select");
  var sessionTabs = document.getElementById("session-tabs");
  var newSessionBtn = document.getElementById("new-session-btn");
  var statusModelEl = document.getElementById("status-model");
  var statusCostEl = document.getElementById("status-cost");
  var statusContextEl = document.getElementById("status-context");
  var statusAgentsEl = document.getElementById("status-agents");
  var statusBusyEl = document.getElementById("status-busy");
  var planModeBanner = document.getElementById("plan-mode-banner");
  var planApprovalCard = document.getElementById("plan-approval-card");
  var planContentEl = document.getElementById("plan-content");
  var planApproveBtn = document.getElementById("plan-approve-btn");
  var planFeedbackBtn = document.getElementById("plan-feedback-btn");
  var createSessionModal = document.getElementById("create-session-modal");
  var modalSessionName = document.getElementById("modal-session-name");
  var modalSessionCwd = document.getElementById("modal-session-cwd");
  var modalCreateBtn = document.getElementById("modal-create-btn");
  var modalCancelBtn = document.getElementById("modal-cancel-btn");
  var qrBtn = document.getElementById("qr-btn");
  var qrModal = document.getElementById("qr-modal");
  var qrModalContainer = document.getElementById("qr-modal-container");
  var qrModalHint = document.getElementById("qr-modal-hint");
  var qrModalClose = document.getElementById("qr-modal-close");
  var historyBtn = document.getElementById("history-btn");
  var historyModal = document.getElementById("history-modal");
  var historyList = document.getElementById("history-list");
  var historyModalClose = document.getElementById("history-modal-close");
  var analyticsBtn = document.getElementById("analytics-btn");
  var analyticsModal = document.getElementById("analytics-modal");
  var analyticsContent = document.getElementById("analytics-content");
  var analyticsCloseBtn = document.getElementById("analytics-close-btn");
  var analyticsExportBtn = document.getElementById("analytics-export-btn");
  var toastContainer = document.getElementById("toast-container");
  var viewSwitcher = document.getElementById("view-switcher");
  var terminalContainer = document.getElementById("terminal-container");

  // ---- Syntax highlighting ----
  var SYNTAX_COLORS = {
    keyword: "#c4a5ff", string: "#4eca6a", comment: "#7a7a7a",
    number: "#ff9a52", "function": "#4a9eff", operator: "#e0e0e0",
    punctuation: "#888888", type: "#4a9eff", property: "#4eca6a",
    plain: "#a0d0ff", diff_add: "#4eca6a", diff_remove: "#ff5b5b"
  };

  function stickyRe(pattern) {
    var flags = pattern.flags.indexOf("y") >= 0 ? pattern.flags : pattern.flags + "y";
    return new RegExp(pattern.source, flags);
  }

  var LANG_JS = [
    { p: stickyRe(/\/\/[^\n]*/), t: "comment" },
    { p: stickyRe(/\/\*[\s\S]*?\*\//), t: "comment" },
    { p: stickyRe(/(["'\`])(?:(?!\1|\\).|\\.)*.?\1/), t: "string" },
    { p: stickyRe(/\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:true|false|null|undefined|NaN|Infinity)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:Array|Boolean|Date|Error|Function|JSON|Map|Math|Number|Object|Promise|Proxy|RegExp|Set|String|Symbol|WeakMap|WeakSet|console|window|document|global|globalThis|process)\b/), t: "type" },
    { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), t: "number" },
    { p: stickyRe(/\b0[oO][0-7][0-7_]*\b/), t: "number" },
    { p: stickyRe(/\b0[bB][01][01_]*\b/), t: "number" },
    { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_$][\w$]*(?=\s*\()/), t: "function" },
    { p: stickyRe(/=>|[+\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\[\];,.]/), t: "punctuation" }
  ];
  var LANG_TS = [
    { p: stickyRe(/\/\/[^\n]*/), t: "comment" },
    { p: stickyRe(/\/\*[\s\S]*?\*\//), t: "comment" },
    { p: stickyRe(/(["'\`])(?:(?!\1|\\).|\\.)*.?\1/), t: "string" },
    { p: stickyRe(/\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|module|namespace|never|new|of|override|package|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:true|false|null|undefined|NaN|Infinity)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:any|bigint|boolean|number|object|string|symbol|unknown|void|never)\b/), t: "type" },
    { p: stickyRe(/\b(?:Array|Boolean|Date|Error|Function|JSON|Map|Math|Number|Object|Promise|Proxy|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|Parameters|RegExp|Set|String|Symbol|WeakMap|WeakSet|console)\b/), t: "type" },
    { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), t: "number" },
    { p: stickyRe(/\b0[oO][0-7][0-7_]*\b/), t: "number" },
    { p: stickyRe(/\b0[bB][01][01_]*\b/), t: "number" },
    { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_$][\w$]*(?=\s*[<(])/), t: "function" },
    { p: stickyRe(/=>|[+\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\[\];,.]/), t: "punctuation" }
  ];
  var LANG_PY = [
    { p: stickyRe(/#[^\n]*/), t: "comment" },
    { p: stickyRe(/"""[\s\S]*?"""/), t: "string" },
    { p: stickyRe(/'''[\s\S]*?'''/), t: "string" },
    { p: stickyRe(/[fFrRbBuU]?(["'])(?:(?!\1|\\).|\\.)*\1/), t: "string" },
    { p: stickyRe(/\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:True|False|None)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:int|float|str|bool|list|dict|tuple|set|frozenset|bytes|bytearray|type|object|range|complex|memoryview|Exception|TypeError|ValueError|KeyError|IndexError|AttributeError|RuntimeError|StopIteration)\b/), t: "type" },
    { p: stickyRe(/\b(?:print|len|range|enumerate|zip|map|filter|sorted|reversed|isinstance|issubclass|hasattr|getattr|setattr|super|property|staticmethod|classmethod|open|input)\b(?=\s*\()/), t: "function" },
    { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), t: "number" },
    { p: stickyRe(/\b0[oO][0-7][0-7_]*\b/), t: "number" },
    { p: stickyRe(/\b0[bB][01][01_]*\b/), t: "number" },
    { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\w*(?=\s*\()/), t: "function" },
    { p: stickyRe(/[-+*/%=!<>&|^~@:]+/), t: "operator" },
    { p: stickyRe(/[{}()\[\];,.]/), t: "punctuation" }
  ];
  var LANG_BASH = [
    { p: stickyRe(/#[^\n]*/), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: "string" },
    { p: stickyRe(/\$\{[^}]*\}/), t: "string" },
    { p: stickyRe(/\$[a-zA-Z_]\w*/), t: "string" },
    { p: stickyRe(/\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|local|export|source|alias|unalias|declare|typeset|readonly|shift|break|continue|exit|eval|exec|trap|set|unset)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:echo|printf|cd|ls|cat|grep|sed|awk|find|xargs|sort|uniq|wc|head|tail|cut|tr|tee|mkdir|rmdir|rm|cp|mv|ln|chmod|chown|chgrp|touch|test|read|write|kill|ps|bg|fg|jobs|wait|nohup|true|false)\b/), t: "function" },
    { p: stickyRe(/\b\d+\b/), t: "number" },
    { p: stickyRe(/[|&;><!=]+/), t: "operator" },
    { p: stickyRe(/[{}()\[\]]/), t: "punctuation" }
  ];
  var LANG_JSON = [
    { p: stickyRe(/"(?:[^"\\]|\\.)*"\s*(?=:)/), t: "property" },
    { p: stickyRe(/"(?:[^"\\]|\\.)*"/), t: "string" },
    { p: stickyRe(/\b(?:true|false|null)\b/), t: "keyword" },
    { p: stickyRe(/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/), t: "number" },
    { p: stickyRe(/:/), t: "operator" },
    { p: stickyRe(/[{}()\[\],]/), t: "punctuation" }
  ];
  var LANG_DIFF = [
    { p: stickyRe(/^\+\+\+[^\n]*/m), t: "keyword" },
    { p: stickyRe(/^---[^\n]*/m), t: "keyword" },
    { p: stickyRe(/^@@[^\n]*@@[^\n]*/m), t: "keyword" },
    { p: stickyRe(/^\+[^\n]*/m), t: "diff_add" },
    { p: stickyRe(/^-[^\n]*/m), t: "diff_remove" }
  ];
  var LANG_HTML = [
    { p: stickyRe(/<!--[\s\S]*?-->/), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: "string" },
    { p: stickyRe(/<\/?[a-zA-Z][\w-]*/), t: "keyword" },
    { p: stickyRe(/\/?>/), t: "keyword" },
    { p: stickyRe(/[a-zA-Z][\w-]*(?=\s*=)/), t: "property" },
    { p: stickyRe(/[=]/), t: "operator" }
  ];
  var LANG_CSS = [
    { p: stickyRe(/\/\*[\s\S]*?\*\//), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: "string" },
    { p: stickyRe(/@[a-zA-Z][\w-]*/), t: "keyword" },
    { p: stickyRe(/\b(?:important|inherit|initial|unset|revert)\b/), t: "keyword" },
    { p: stickyRe(/#[0-9a-fA-F]{3,8}\b/), t: "number" },
    { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|deg|rad|s|ms|Hz|kHz|fr)?\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z][\w-]*(?=\s*\()/), t: "function" },
    { p: stickyRe(/[a-zA-Z-]+(?=\s*:)/), t: "property" },
    { p: stickyRe(/[.#][a-zA-Z][\w-]*/), t: "type" },
    { p: stickyRe(/[:;{}(),>+~*=]/), t: "punctuation" }
  ];
  var LANG_YAML = [
    { p: stickyRe(/#[^\n]*/), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: "string" },
    { p: stickyRe(/[a-zA-Z_][\w.-]*(?=\s*:)/), t: "property" },
    { p: stickyRe(/\b(?:true|false|null|yes|no|on|off)\b/i), t: "keyword" },
    { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?\b/), t: "number" },
    { p: stickyRe(/[:\-|>]/), t: "operator" }
  ];
  var LANG_GO = [
    { p: stickyRe(/\/\/[^\n]*/), t: "comment" },
    { p: stickyRe(/\/\*[\s\S]*?\*\//), t: "comment" },
    { p: stickyRe(/(["'\`])(?:(?!\1|\\).|\\.)*.?\1/), t: "string" },
    { p: stickyRe(/\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:true|false|nil|iota)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr)\b/), t: "type" },
    { p: stickyRe(/\b(?:append|cap|close|copy|delete|len|make|new|panic|print|println|recover)\b(?=\s*\()/), t: "function" },
    { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), t: "number" },
    { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\w*(?=\s*\()/), t: "function" },
    { p: stickyRe(/:=|[+\-*/%=!<>&|^~]+/), t: "operator" },
    { p: stickyRe(/[{}()\[\];,.]/), t: "punctuation" }
  ];
  var LANG_RUST = [
    { p: stickyRe(/\/\/[^\n]*/), t: "comment" },
    { p: stickyRe(/\/\*[\s\S]*?\*\//), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: "string" },
    { p: stickyRe(/\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while|yield)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:true|false)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|Cell|RefCell|HashMap|HashSet|BTreeMap|BTreeSet)\b/), t: "type" },
    { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/), t: "number" },
    { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\w*(?=\s*[!(<])/), t: "function" },
    { p: stickyRe(/=>|->|[+\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\[\];,.#]/), t: "punctuation" }
  ];
  var LANG_JAVA = [
    { p: stickyRe(/\/\/[^\n]*/), t: "comment" },
    { p: stickyRe(/\/\*[\s\S]*?\*\//), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: "string" },
    { p: stickyRe(/\b(?:abstract|assert|break|case|catch|class|const|continue|default|do|else|enum|extends|final|finally|for|goto|if|implements|import|instanceof|interface|native|new|package|private|protected|public|return|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:true|false|null)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:boolean|byte|char|double|float|int|long|short|var|String|Integer|Long|Double|Float|Boolean|Character|Object|Class|System|List|Map|Set|ArrayList|HashMap|HashSet|Optional|Stream)\b/), t: "type" },
    { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F_]*[lL]?\b/), t: "number" },
    { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?[lLfFdD]?\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\w*(?=\s*\()/), t: "function" },
    { p: stickyRe(/[+\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\[\];,.@]/), t: "punctuation" }
  ];
  var LANG_RUBY = [
    { p: stickyRe(/#[^\n]*/), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: "string" },
    { p: stickyRe(/\bdefined\?/), t: "keyword" },
    { p: stickyRe(/\b(?:alias|and|begin|break|case|class|def|do|else|elsif|end|ensure|for|if|in|module|next|nil|not|or|redo|require|rescue|retry|return|self|super|then|undef|unless|until|when|while|yield)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:true|false|nil)\b/), t: "keyword" },
    { p: stickyRe(/:[a-zA-Z_]\w*/), t: "string" },
    { p: stickyRe(/\b\d[\d_]*(?:\.[\d_]*)?\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\w*(?=\s*[({])/), t: "function" },
    { p: stickyRe(/[+\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\[\];,.@]/), t: "punctuation" }
  ];
  var LANG_C = [
    { p: stickyRe(/\/\/[^\n]*/), t: "comment" },
    { p: stickyRe(/\/\*[\s\S]*?\*\//), t: "comment" },
    { p: stickyRe(/(["'])(?:(?!\1|\\).|\\.)*\1/), t: "string" },
    { p: stickyRe(/#\s*(?:include|define|ifdef|ifndef|endif|if|else|elif|undef|pragma|error|warning)[^\n]*/), t: "keyword" },
    { p: stickyRe(/\b(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|_Bool|_Complex|_Imaginary)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:NULL|true|false)\b/), t: "keyword" },
    { p: stickyRe(/\b(?:size_t|ptrdiff_t|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|FILE|bool)\b/), t: "type" },
    { p: stickyRe(/\b0[xX][0-9a-fA-F][0-9a-fA-F]*[uUlL]*\b/), t: "number" },
    { p: stickyRe(/\b\d[\d]*(?:\.[\d]*)?(?:[eE][+-]?\d+)?[uUlLfF]*\b/), t: "number" },
    { p: stickyRe(/[a-zA-Z_]\w*(?=\s*\()/), t: "function" },
    { p: stickyRe(/->|[+\-*/%=!<>&|^~?:]+/), t: "operator" },
    { p: stickyRe(/[{}()\[\];,.]/), t: "punctuation" }
  ];
  var LANG_SQL = [
    { p: stickyRe(/--[^\n]*/), t: "comment" },
    { p: stickyRe(/\/\*[\s\S]*?\*\//), t: "comment" },
    { p: stickyRe(/'(?:[^'\\]|\\.)*'/), t: "string" },
    { p: stickyRe(/\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DATABASE|SCHEMA|JOIN|INNER|LEFT|RIGHT|OUTER|CROSS|ON|AND|OR|NOT|IN|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|EXISTS|BETWEEN|LIKE|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|CHECK|DEFAULT|CONSTRAINT|BEGIN|COMMIT|ROLLBACK|TRANSACTION|WITH|RETURNING|ASC|DESC)\b/i), t: "keyword" },
    { p: stickyRe(/\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|CHAR|VARCHAR|TEXT|BLOB|BOOLEAN|BOOL|DATE|TIME|TIMESTAMP|DATETIME|SERIAL|UUID|JSON|JSONB|ARRAY|BYTEA)\b/i), t: "type" },
    { p: stickyRe(/\b(?:COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|TRIM|UPPER|LOWER|LENGTH|SUBSTR|SUBSTRING|REPLACE|CONCAT|NOW|ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|OVER|PARTITION)\b(?=\s*\()/i), t: "function" },
    { p: stickyRe(/\b\d+(?:\.\d+)?\b/), t: "number" },
    { p: stickyRe(/[=<>!]+|[+\-*/%]/), t: "operator" },
    { p: stickyRe(/[();,.]/), t: "punctuation" }
  ];

  var SYNTAX_LANGS = {
    javascript: LANG_JS, typescript: LANG_TS, jsx: LANG_JS, tsx: LANG_TS,
    python: LANG_PY, bash: LANG_BASH, json: LANG_JSON, diff: LANG_DIFF,
    html: LANG_HTML, xml: LANG_HTML, css: LANG_CSS, yaml: LANG_YAML,
    go: LANG_GO, rust: LANG_RUST, java: LANG_JAVA, ruby: LANG_RUBY,
    c: LANG_C, cpp: LANG_C, sql: LANG_SQL
  };
  var SYNTAX_ALIASES = {
    js: "javascript", ts: "typescript", py: "python", sh: "bash",
    shell: "bash", zsh: "bash", yml: "yaml", htm: "html", rb: "ruby",
    rs: "rust", "c++": "cpp", h: "c", hpp: "cpp", cc: "cpp", cxx: "cpp",
    patch: "diff", mysql: "sql", postgresql: "sql", postgres: "sql",
    sqlite: "sql", kt: "java", kotlin: "java", scala: "java",
    cs: "java", csharp: "java", swift: "c", jsonc: "json", json5: "json",
    toml: "yaml"
  };

  function getSyntaxRules(lang) {
    if (!lang) return null;
    var key = lang.toLowerCase();
    return SYNTAX_LANGS[key] || SYNTAX_LANGS[SYNTAX_ALIASES[key] || ""] || null;
  }

  var MAX_HIGHLIGHT_LENGTH = 5000;

  function tokenize(code, lang) {
    if (!lang || code.length > MAX_HIGHLIGHT_LENGTH) return [{ text: code, type: "plain" }];
    var rules = getSyntaxRules(lang);
    if (!rules) return [{ text: code, type: "plain" }];
    var tokens = [];
    var pos = 0;
    var plainStart = 0;
    while (pos < code.length) {
      var matched = false;
      for (var ri = 0; ri < rules.length; ri++) {
        rules[ri].p.lastIndex = pos;
        var m = rules[ri].p.exec(code);
        if (m) {
          if (pos > plainStart) pushToken(tokens, code.slice(plainStart, pos), "plain");
          pushToken(tokens, m[0], rules[ri].t);
          pos += m[0].length;
          plainStart = pos;
          matched = true;
          break;
        }
      }
      if (!matched) pos++;
    }
    if (pos > plainStart) pushToken(tokens, code.slice(plainStart, pos), "plain");
    return tokens;
  }

  function pushToken(tokens, text, type) {
    var last = tokens.length > 0 ? tokens[tokens.length - 1] : null;
    if (last && last.type === type) { last.text += text; }
    else { tokens.push({ text: text, type: type }); }
  }

  function highlightCode(code, lang) {
    var tokens = tokenize(code, lang);
    var out = "";
    for (var i = 0; i < tokens.length; i++) {
      var color = SYNTAX_COLORS[tokens[i].type] || SYNTAX_COLORS.plain;
      out += '<span style="color:' + color + '">' + escapeHtml(tokens[i].text) + '</span>';
    }
    return out;
  }

  // ---- Markdown renderer ----
  function renderMarkdown(text) {
    if (!text) return "";

    // Extract fenced code blocks BEFORE HTML-escaping (so highlighter gets raw code)
    var codeBlocks = [];
    var raw = text.replace(/\`\`\`(\w*)?\n([\s\S]*?)\`\`\`/g, function(m, lang, code) {
      var placeholder = "\x00CB" + codeBlocks.length + "\x00";
      var cls = lang ? ' class="language-' + lang + '"' : "";
      var highlighted = lang ? highlightCode(code, lang) : escapeHtml(code);
      codeBlocks.push('<pre><code' + cls + '>' + highlighted + '</code></pre>');
      return placeholder;
    });

    // Extract inline code before escaping
    raw = raw.replace(/\`([^\`\n]+)\`/g, function(m, code) {
      var placeholder = "\x00CB" + codeBlocks.length + "\x00";
      codeBlocks.push("<code>" + escapeHtml(code) + "</code>");
      return placeholder;
    });

    // Now HTML-escape the remaining text
    var html = raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Headers
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Links — sanitize URL scheme to block javascript:/data:/vbscript:
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(m, text, url) {
      if (/^\s*(javascript|data|vbscript)\s*:/i.test(url)) {
        return text;
      }
      var safeUrl = url.replace(/"/g, "&quot;");
      return '<a href="' + safeUrl + '" target="_blank" rel="noopener">' + text + '</a>';
    });

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\/li>\n?)+/g, function(m) {
      return "<ul>" + m + "</ul>";
    });

    // Ordered lists — wrap in <ol>
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

    // Paragraphs (double newlines)
    html = html.replace(/\n\n/g, "</p><p>");
    // Single newlines to <br>
    html = html.replace(/\n/g, "<br>");

    // Restore code blocks from placeholders
    for (var i = 0; i < codeBlocks.length; i++) {
      html = html.replace("\x00CB" + i + "\x00", codeBlocks[i]);
    }

    return html;
  }

  // ---- Auto-scroll logic ----
  messagesEl.addEventListener("scroll", function() {
    var threshold = 60;
    var atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
    userScrolledUp = !atBottom;
  });

  function scrollToBottom() {
    if (!userScrolledUp) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // ---- Persistence functions ----
  function saveMessages() {
    if (!activeSessionId) return;
    try {
      var toStore = messageLog.slice(-MAX_STORED_MESSAGES).map(function(entry) {
        var e = Object.assign({}, entry);
        if (e.content && e.content.length > MAX_ENTRY_SIZE) {
          e.content = e.content.slice(0, MAX_ENTRY_SIZE) + "\n[truncated]";
        }
        if (e.result && e.result.length > MAX_ENTRY_SIZE) {
          e.result = e.result.slice(0, MAX_ENTRY_SIZE) + "\n[truncated]";
        }
        return e;
      });
      localStorage.setItem(STORAGE_PREFIX + "messages_" + activeSessionId, JSON.stringify(toStore));
      localStorage.setItem(STORAGE_PREFIX + "active_session", activeSessionId);
    } catch (e) {
      console.warn("[dashboard] Failed to save messages:", e);
    }
  }

  function debouncedSave() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(saveMessages, 500);
  }

  function loadMessages(sessionId) {
    try {
      var data = localStorage.getItem(STORAGE_PREFIX + "messages_" + sessionId);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  function restoreMessages(sessionId) {
    if (!sessionId) return;
    if (messageLog.length > 0) return; // already have messages
    var stored = loadMessages(sessionId);
    if (stored.length === 0) return;
    restoredFromCache = true;
    messageLog = stored;
    stored.forEach(function(entry) {
      if (entry.type === "tool") {
        var bubble = addToolBubble(entry.tool || "tool", entry.toolUseId || "", entry.input || null, true);
        if (entry.result && bubble) {
          var resultDiv = bubble.querySelector(".tool-result");
          if (resultDiv) resultDiv.textContent = entry.result;
        }
      } else if (entry.type === "permission") {
        addPermissionPrompt(entry.requestId || "", entry.tool || "Unknown", entry.description || "", null, true);
      } else {
        addMessage(entry.msgType || "system", entry.content || "", { skipLog: true });
      }
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function logMessage(entry) {
    messageLog.push(entry);
    debouncedSave();
  }

  // ---- Terminal functions ----
  function initTerminal() {
    if (term) return;
    if (typeof Terminal === "undefined") {
      terminalContainer.innerHTML = '<div class="terminal-notice"><div class="notice-title">Terminal Unavailable</div><div>xterm.js could not be loaded</div></div>';
      return;
    }
    term = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      scrollback: 5000,
      fontSize: 14,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: "#0f0f1a",
        foreground: "#f8f8f2",
        cursor: "#f8f8f0",
        black: "#000000",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#bd93f9",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#bfbfbf",
        brightBlack: "#4d4d4d",
        brightRed: "#ff6e67",
        brightGreen: "#5af78e",
        brightYellow: "#f4f99d",
        brightBlue: "#caa9fa",
        brightMagenta: "#ff92d0",
        brightCyan: "#9aedfe",
        brightWhite: "#e6e6e6"
      }
    });
    if (typeof FitAddon !== "undefined") {
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    }
    term.open(terminalContainer);
    if (fitAddon) {
      try { fitAddon.fit(); } catch(e) {}
    }
    // Resize on container resize
    var resizeTimer = null;
    var ro = new ResizeObserver(function() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function() {
        if (fitAddon && currentView === "terminal") {
          try { fitAddon.fit(); } catch(e) {}
        }
      }, 250);
    });
    ro.observe(terminalContainer);
  }

  function switchView(view) {
    if (view === currentView) return;
    currentView = view;
    // Update tab active states and ARIA
    viewSwitcher.querySelectorAll(".view-tab").forEach(function(tab) {
      var isActive = tab.getAttribute("data-view") === view;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    if (view === "chat") {
      messagesEl.classList.remove("hidden");
      terminalContainer.classList.add("hidden");
      scrollToBottom();
    } else {
      messagesEl.classList.add("hidden");
      terminalContainer.classList.remove("hidden");
      if (serverMode === "cli") {
        if (!terminalContainer.querySelector(".terminal-notice")) {
          terminalContainer.innerHTML = '<div class="terminal-notice"><div class="notice-title">Terminal Not Available</div><div>Terminal view is not available for this session.</div></div>';
        }
      } else {
        initTerminal();
        if (term && terminalBuffer) {
          term.reset();
          term.write(terminalBuffer);
        }
        if (fitAddon) {
          try { fitAddon.fit(); } catch(e) {}
        }
      }
    }
    // Tell server which view we want
    send({ type: "mode", mode: view === "terminal" ? "terminal" : "chat" });
  }

  // View switcher click handler
  viewSwitcher.addEventListener("click", function(e) {
    var tab = e.target.closest(".view-tab");
    if (!tab) return;
    switchView(tab.getAttribute("data-view"));
  });

  // ---- Textarea auto-resize ----
  inputEl.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 150) + "px";
  });

  // ---- Message rendering ----
  function addMessage(type, content, opts) {
    opts = opts || {};
    var div = document.createElement("div");

    if (type === "assistant" || type === "response") {
      div.className = "msg assistant";
      div.innerHTML = renderMarkdown(content);
    } else if (type === "user" || type === "user_input") {
      div.className = "msg user";
      div.textContent = content;
    } else if (type === "system") {
      div.className = "msg system";
      div.textContent = content;
    } else if (type === "error") {
      div.className = "msg error";
      div.textContent = content;
    }

    if (opts.id) div.setAttribute("data-msg-id", sanitizeId(opts.id));
    messagesEl.appendChild(div);
    scrollToBottom();
    if (!opts.skipLog) {
      logMessage({ msgType: type, content: content, timestamp: Date.now() });
    }
    return div;
  }

  function addToolBubble(tool, toolUseId, input, skipLog) {
    var div = document.createElement("div");
    div.className = "tool-bubble";
    div.setAttribute("data-tool-id", sanitizeId(toolUseId || ""));
    var inputSummary = "";
    if (input) {
      if (typeof input === "object") {
        // Show the most useful field
        inputSummary = input.command || input.file_path || input.path || input.description || "";
        if (typeof inputSummary !== "string") inputSummary = JSON.stringify(inputSummary).slice(0, 100);
      } else {
        inputSummary = String(input).slice(0, 100);
      }
    }
    div.innerHTML = '<span class="tool-name">' + escapeHtml(tool) + '</span>' +
      (inputSummary ? ' <span style="color:#666">' + escapeHtml(inputSummary) + '</span>' : "") +
      '<div class="tool-result"></div>';
    div.addEventListener("click", function() {
      div.classList.toggle("expanded");
    });
    messagesEl.appendChild(div);
    scrollToBottom();
    if (!skipLog) {
      logMessage({ type: "tool", tool: tool, toolUseId: toolUseId, input: inputSummary, timestamp: Date.now() });
    }
    return div;
  }

  function addPermissionPrompt(requestId, tool, description, remainingMs, skipLog) {
    var div = document.createElement("div");
    div.className = "permission-prompt";
    div.setAttribute("data-request-id", sanitizeId(requestId));
    div.innerHTML =
      '<div class="perm-desc"><span class="perm-tool">' + escapeHtml(tool) + '</span>: ' +
      escapeHtml(description || "Permission requested") + '</div>' +
      '<div class="perm-countdown"></div>' +
      '<div class="perm-buttons">' +
      '<button class="btn-allow" data-decision="allow">Allow</button>' +
      '<button class="btn-deny" data-decision="deny">Deny</button>' +
      '</div>' +
      '<div class="perm-answer" style="display:none"></div>';

    // Countdown timer — handle expired, active, and missing states
    var countdownEl = div.querySelector(".perm-countdown");
    var countdownInterval = null;
    if (typeof remainingMs === "number") {
      if (remainingMs > 0 && !skipLog) {
        var expiresAt = Date.now() + remainingMs;
        function updateCountdown() {
          var remaining = Math.max(0, expiresAt - Date.now());
          if (remaining <= 0) {
            clearInterval(countdownInterval);
            activeCountdowns = activeCountdowns.filter(function(id) { return id !== countdownInterval; });
            countdownEl.textContent = "Timed out";
            countdownEl.classList.add("expired");
            return;
          }
          var mins = Math.floor(remaining / 60000);
          var secs = Math.floor((remaining % 60000) / 1000);
          countdownEl.textContent = mins + ":" + (secs < 10 ? "0" : "") + secs;
          if (remaining <= 30000) {
            countdownEl.classList.add("urgent");
          }
        }
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
        activeCountdowns.push(countdownInterval);
      } else {
        // Zero or negative remaining — immediately expired
        countdownEl.textContent = "Timed out";
        countdownEl.classList.add("expired");
      }
    } else {
      // No remainingMs (older servers or restored prompts) — hide countdown
      countdownEl.style.display = "none";
    }

    div.querySelectorAll("button").forEach(function(btn) {
      btn.addEventListener("click", function() {
        if (countdownInterval) {
          clearInterval(countdownInterval);
          activeCountdowns = activeCountdowns.filter(function(id) { return id !== countdownInterval; });
        }
        var decision = btn.getAttribute("data-decision");
        sendPermissionResponse(requestId, decision);
        div.classList.add("answered");
        div.querySelector(".perm-answer").textContent = decision === "allow" ? "Allowed" : "Denied";
        div.querySelector(".perm-answer").style.display = "block";
        countdownEl.style.display = "none";
      });
    });
    messagesEl.appendChild(div);
    scrollToBottom();
    if (!skipLog) {
      logMessage({ type: "permission", requestId: requestId, tool: tool, description: description, timestamp: Date.now() });
    }
    return div;
  }

  function addQuestionPrompt(question, toolUseId, options) {
    var div = document.createElement("div");
    div.className = "question-prompt";
    div.setAttribute("data-tool-use-id", sanitizeId(toolUseId || ""));

    var html = '<div class="q-text">' + escapeHtml(question) + '</div>';

    // If options are provided, show them as buttons
    if (Array.isArray(options) && options.length > 0) {
      html += '<div class="q-options">';
      options.forEach(function(opt) {
        html += '<button class="q-option-btn">' + escapeHtml(opt) + '</button>';
      });
      html += '</div>';
    }

    // Always show text input as fallback
    html += '<div class="q-input-row">' +
      '<input type="text" placeholder="Type your answer...">' +
      '<button>Reply</button>' +
      '</div>' +
      '<div class="q-answer-text"></div>';

    div.innerHTML = html;

    // Option button handlers
    div.querySelectorAll(".q-option-btn").forEach(function(btn) {
      btn.addEventListener("click", function() {
        if (div.classList.contains("answered")) return;
        var answer = btn.textContent;
        sendQuestionResponse(answer, toolUseId);
        div.querySelector(".q-answer-text").textContent = "Answered: " + answer;
        div.classList.add("answered");
      });
    });

    // Text input handler
    var qInput = div.querySelector("input");
    var qBtn = div.querySelector(".q-input-row button");
    function submitAnswer() {
      if (div.classList.contains("answered")) return;
      var answer = qInput.value.trim();
      if (!answer) return;
      sendQuestionResponse(answer, toolUseId);
      div.querySelector(".q-answer-text").textContent = "Answered: " + answer;
      div.classList.add("answered");
    }
    qBtn.addEventListener("click", submitAnswer);
    qInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter") submitAnswer();
    });
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function showThinking() {
    removeThinking();
    var div = document.createElement("div");
    div.className = "thinking-dots";
    div.id = "thinking-indicator";
    div.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function removeThinking() {
    var el = document.getElementById("thinking-indicator");
    if (el) el.remove();
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function sanitizeId(id) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  }

  // ---- Session tabs ----
  function renderSessions() {
    sessionTabs.innerHTML = "";
    var showClose = sessions.length > 1;
    sessions.forEach(function(s) {
      var tab = document.createElement("div");
      tab.className = "session-tab" + (s.sessionId === activeSessionId ? " active" : "");

      // Busy indicator dot
      if (s.isBusy) {
        var dot = document.createElement("span");
        dot.className = "tab-busy-dot";
        tab.appendChild(dot);
      }

      var nameSpan = document.createElement("span");
      nameSpan.className = "tab-name";
      nameSpan.textContent = s.name || "Default";
      tab.appendChild(nameSpan);

      // Abbreviated cwd
      if (s.cwd) {
        var cwdSpan = document.createElement("span");
        cwdSpan.className = "tab-cwd";
        var parts = s.cwd.split(/[\/]/);
        cwdSpan.textContent = parts[parts.length - 1] || s.cwd;
        cwdSpan.title = s.cwd;
        tab.appendChild(cwdSpan);
      }

      // Model badge (short name)
      if (s.model) {
        var modelBadge = document.createElement("span");
        modelBadge.className = "tab-model";
        var short = s.model.replace(/^claude-/, "").replace(/-\d.*$/, "");
        modelBadge.textContent = short;
        tab.appendChild(modelBadge);
      }

      // Close button (hidden when only 1 session)
      var closeBtn = document.createElement("button");
      closeBtn.className = "tab-close" + (showClose ? " visible" : "");
      closeBtn.innerHTML = "&times;";
      closeBtn.title = "Destroy session";
      closeBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        if (window.confirm("Destroy session '" + (s.name || "Default") + "'?")) {
          send({ type: "destroy_session", sessionId: s.sessionId });
        }
      });
      tab.appendChild(closeBtn);

      // Click to switch session
      tab.addEventListener("click", function() {
        if (s.sessionId !== activeSessionId) {
          send({ type: "switch_session", sessionId: s.sessionId });
        }
      });

      // Double-click to rename session (inline editing)
      tab.addEventListener("dblclick", function(e) {
        e.preventDefault();
        e.stopPropagation();
        startInlineRename(tab, s);
      });

      sessionTabs.appendChild(tab);
    });
  }

  function startInlineRename(tab, session) {
    var nameSpan = tab.querySelector(".tab-name");
    if (!nameSpan) return;
    var input = document.createElement("input");
    input.type = "text";
    input.className = "tab-rename-input";
    input.value = session.name || "Default";
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      var newName = input.value.trim();
      if (newName && newName !== (session.name || "Default")) {
        send({ type: "rename_session", sessionId: session.sessionId, name: newName });
      }
      // Re-render regardless to restore normal tab look
      renderSessions();
    }
    function cancel() {
      renderSessions();
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", function(e) {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); input.removeEventListener("blur", commit); cancel(); }
    });
  }

  // ---- Create session modal ----
  function openCreateSessionModal() {
    modalSessionName.value = "";
    modalSessionCwd.value = "";
    createSessionModal.classList.remove("hidden");
    modalOpen = true;
    modalSessionName.focus();
  }

  function closeCreateSessionModal() {
    createSessionModal.classList.add("hidden");
    modalOpen = false;
  }

  function submitCreateSession() {
    var name = modalSessionName.value.trim();
    var cwd = modalSessionCwd.value.trim();
    if (!name) { modalSessionName.focus(); return; }
    var msg = { type: "create_session", name: name };
    if (cwd) msg.cwd = cwd;
    send(msg);
    closeCreateSessionModal();
  }

  newSessionBtn.addEventListener("click", function() {
    openCreateSessionModal();
  });

  modalCreateBtn.addEventListener("click", submitCreateSession);
  modalCancelBtn.addEventListener("click", closeCreateSessionModal);

  // Close modal on backdrop click
  createSessionModal.addEventListener("click", function(e) {
    if (e.target === createSessionModal) closeCreateSessionModal();
  });

  // Modal keyboard: Enter to submit, Escape to close
  createSessionModal.addEventListener("keydown", function(e) {
    if (e.key === "Enter") { e.preventDefault(); submitCreateSession(); }
    if (e.key === "Escape") { e.preventDefault(); closeCreateSessionModal(); }
  });

  // ---- QR pairing modal ----
  function openQrModal() {
    qrModalContainer.innerHTML = '<span style="color:#555;font-size:13px;">Loading...</span>';
    qrModalHint.textContent = 'Scan with Chroxy app to connect';
    qrModal.classList.remove("hidden");
    modalOpen = true;

    fetch('/qr', { headers: token ? { 'Authorization': 'Bearer ' + token } : {} })
      .then(function(r) {
        if (!r.ok) throw new Error(r.status);
        var ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('image/svg+xml')) throw new Error('unexpected_content_type');
        return r.text();
      })
      .then(function(svg) {
        qrModalContainer.innerHTML = svg;
        // Scale SVG to fill container
        var svgEl = qrModalContainer.querySelector('svg');
        if (svgEl) {
          svgEl.setAttribute('width', '180');
          svgEl.setAttribute('height', '180');
        }
      })
      .catch(function() {
        qrModalContainer.innerHTML = '<span style="color:#f87171;font-size:13px;">QR unavailable</span>';
        qrModalHint.textContent = 'Connection info not available. Is a tunnel configured?';
      });
  }

  function closeQrModal() {
    qrModal.classList.add("hidden");
    modalOpen = false;
  }

  qrBtn.addEventListener("click", openQrModal);
  qrModalClose.addEventListener("click", closeQrModal);
  qrModal.addEventListener("click", function(e) {
    if (e.target === qrModal) closeQrModal();
  });
  qrModal.addEventListener("keydown", function(e) {
    if (e.key === "Escape") { e.preventDefault(); closeQrModal(); }
  });

  // ---- History modal ----
  function relativeTime(isoStr) {
    var ms = Date.now() - new Date(isoStr).getTime();
    var s = Math.floor(ms / 1000);
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    if (d === 1) return "yesterday";
    if (d < 30) return d + "d ago";
    return new Date(isoStr).toLocaleDateString();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + "B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + "KB";
    return (bytes / (1024 * 1024)).toFixed(1) + "MB";
  }

  function openHistoryModal() {
    historyList.innerHTML = '<div class="history-loading">Scanning conversations...</div>';
    historyModal.classList.remove("hidden");
    modalOpen = true;
    send({ type: "list_conversations" });
  }

  function closeHistoryModal() {
    historyModal.classList.add("hidden");
    modalOpen = false;
  }

  function renderConversations(conversations) {
    if (!conversations || conversations.length === 0) {
      historyList.innerHTML = '<div class="history-empty">No conversation history found</div>';
      return;
    }
    // Group by projectName
    var groups = {};
    var groupOrder = [];
    conversations.forEach(function(c) {
      var key = c.projectName || "Unknown";
      if (!groups[key]) {
        groups[key] = [];
        groupOrder.push(key);
      }
      groups[key].push(c);
    });

    var html = "";
    groupOrder.forEach(function(name) {
      html += '<div class="history-group">';
      html += '<div class="history-group-name">' + escapeHtml(name) + '</div>';
      groups[name].forEach(function(c) {
        var preview = c.preview ? escapeHtml(c.preview.slice(0, 80)) : '<em style="color:#555">No preview</em>';
        var time = relativeTime(c.modifiedAt);
        var size = formatSize(c.sizeBytes);
        html += '<div class="history-item" data-conv-id="' + escapeHtml(c.conversationId) + '" data-cwd="' + escapeHtml(c.cwd || "") + '">';
        html += '<div class="history-item-body">';
        html += '<div class="history-item-preview">' + preview + '</div>';
        html += '<div class="history-item-meta">' + time + ' &middot; ' + size + '</div>';
        html += '</div>';
        html += '<button class="history-item-resume">Resume</button>';
        html += '</div>';
      });
      html += '</div>';
    });
    historyList.innerHTML = html;

    // Attach click handlers
    historyList.querySelectorAll(".history-item-resume").forEach(function(btn) {
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        var item = btn.closest(".history-item");
        var convId = item.getAttribute("data-conv-id");
        var cwd = item.getAttribute("data-cwd");
        send({ type: "resume_conversation", conversationId: convId, cwd: cwd || undefined });
        closeHistoryModal();
      });
    });
  }

  historyBtn.addEventListener("click", openHistoryModal);
  historyModalClose.addEventListener("click", closeHistoryModal);
  historyModal.addEventListener("click", function(e) {
    if (e.target === historyModal) closeHistoryModal();
  });
  historyModal.addEventListener("keydown", function(e) {
    if (e.key === "Escape") { e.preventDefault(); closeHistoryModal(); }
  });

  // ---- Model + permission selects ----
  modelSelect.addEventListener("change", function() {
    if (modelSelect.value) {
      send({ type: "set_model", model: modelSelect.value });
    }
  });

  permissionSelect.addEventListener("change", function() {
    send({ type: "set_permission_mode", mode: permissionSelect.value });
  });

  function updateModelSelect() {
    var previousValue = modelSelect.value;
    modelSelect.innerHTML = "";
    // Keep placeholder when no models available yet
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Model";
    modelSelect.appendChild(placeholder);
    if (!availableModels || availableModels.length === 0) return;
    availableModels.forEach(function(m) {
      var opt = document.createElement("option");
      opt.value = m.id || m.fullId || m;
      opt.textContent = m.label || m.id || m;
      modelSelect.appendChild(opt);
    });
    if (activeModel) {
      // Try to select by matching label or id (skip placeholder at 0)
      for (var i = 1; i < modelSelect.options.length; i++) {
        var optLabel = modelSelect.options[i].textContent.toLowerCase();
        var optVal = modelSelect.options[i].value.toLowerCase();
        if (optLabel === activeModel.toLowerCase() || optVal === activeModel.toLowerCase()) {
          modelSelect.selectedIndex = i;
          return;
        }
      }
    }
    // Fall back to previous selection if possible
    if (previousValue) {
      for (var j = 1; j < modelSelect.options.length; j++) {
        if (modelSelect.options[j].value === previousValue) {
          modelSelect.selectedIndex = j;
          return;
        }
      }
    }
  }

  // ---- Status bar ----
  function updateStatusBar() {
    statusModelEl.textContent = statusModel || activeModel || "";
    statusCostEl.textContent = statusCost ? "$" + statusCost.toFixed(4) : "";
    statusContextEl.textContent = statusContext || "";
  }

  function updateAgentBadge() {
    var count = backgroundAgents.size;
    if (count > 0) {
      statusAgentsEl.textContent = count + (count === 1 ? " agent" : " agents");
      statusAgentsEl.classList.remove("hidden");
    } else {
      statusAgentsEl.classList.add("hidden");
    }
  }

  function updateBusyIndicator() {
    if (isBusy) {
      statusBusyEl.classList.remove("hidden");
    } else {
      statusBusyEl.classList.add("hidden");
    }
  }

  // ---- Toast notifications ----
  function showToast(message) {
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "alert");
    toast.innerHTML =
      '<span class="toast-msg">' + escapeHtml(message) + '</span>' +
      '<button class="toast-close" aria-label="Close notification">&times;</button>';
    toast.querySelector(".toast-close").addEventListener("click", function() {
      toast.remove();
    });
    while (toastContainer.children.length >= 5) { toastContainer.removeChild(toastContainer.firstChild); }
    toastContainer.appendChild(toast);
    // Auto-dismiss after 5 seconds
    setTimeout(function() {
      if (toast.parentNode) toast.remove();
    }, 5000);
  }

  // ---- Connection status ----
  function setConnectionState(state) {
    statusDot.className = "status-dot " + state;
    connected = state === "connected";
    if (state === "connected") {
      hadInitialConnect = true;
      reconnectAttempt = 0;
      reconnectBanner.classList.add("hidden");
      reauthContainer.classList.add("hidden");
    }
    updateButtons();
  }

  function updateButtons() {
    sendBtn.disabled = !connected || !claudeReady;
    interruptBtn.disabled = !connected || !isBusy;
  }

  // ---- WebSocket connection ----
  function connect() {
    if (ws) {
      try { ws.close(); } catch(e) {}
    }
    serverProtocolVersion = null;
    setConnectionState("connecting");

    var url = "ws://localhost:" + port;
    ws = new WebSocket(url);

    ws.onopen = function() {
      // Send auth
      send({
        type: "auth",
        token: token,
        deviceInfo: {
          deviceName: "Web Dashboard",
          deviceType: "desktop",
          platform: "web"
        }
      });
    };

    ws.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch(e) {
        console.error("[dashboard] Failed to parse message:", e);
      }
    };

    ws.onclose = function() {
      setConnectionState("disconnected");
      connected = false;
      claudeReady = false;
      isBusy = false;
      updateBusyIndicator();
      updateButtons();
      // Auto-reconnect with escalating backoff (skip if waiting for re-auth)
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (reauthRequired) return;
      if (hadInitialConnect) {
        reconnectRetryBtn.classList.add("hidden");
        if (reconnectAttempt < MAX_RETRIES) {
          var delay = RETRY_DELAYS[Math.min(reconnectAttempt, RETRY_DELAYS.length - 1)];
          reconnectText.textContent = "Disconnected. Reconnecting in " + Math.round(delay / 1000) + "s (" + (reconnectAttempt + 1) + "/" + MAX_RETRIES + ")...";
          reconnectBanner.classList.remove("hidden");
          reconnectTimer = setTimeout(function() {
            reconnectAttempt++;
            loadCostEvents();
  connect();
          }, delay);
        } else {
          reconnectText.textContent = "Connection lost.";
          reconnectRetryBtn.classList.remove("hidden");
          reconnectBanner.classList.remove("hidden");
        }
      } else {
        // Initial connection attempt — retry quickly
        reconnectTimer = setTimeout(function() {
          loadCostEvents();
  connect();
        }, 1000);
      }
    };

    ws.onerror = function(err) {
      console.error("[dashboard] WebSocket error:", err);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function sendInput(text) {
    if (!text || !text.trim()) return;
    if (!connected || !claudeReady) return;
    send({ type: "input", data: text.trim() });
    addMessage("user", text.trim(), { skipLog: false });
    inputEl.value = "";
    inputEl.style.height = "auto";
    isBusy = true;
    updateButtons();
  }

  function sendInterrupt() {
    send({ type: "interrupt" });
  }

  function sendPermissionResponse(requestId, decision) {
    send({ type: "permission_response", requestId: requestId, decision: decision });
  }

  function sendQuestionResponse(answer, toolUseId) {
    var msg = { type: "user_question_response", answer: answer };
    if (toolUseId) msg.toolUseId = toolUseId;
    send(msg);
  }

  // ---- Message handler ----
  function handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "auth_ok":
        setConnectionState("connected");
        if (msg.serverMode) {
          serverMode = msg.serverMode;
        }
        if (typeof msg.protocolVersion === "number") {
          serverProtocolVersion = msg.protocolVersion;
        }
        break;

      case "server_mode":
        serverMode = msg.mode || null;
        break;

      case "raw":
        if (msg.data) {
          terminalBuffer += msg.data;
          if (terminalBuffer.length > TERMINAL_BUFFER_MAX) {
            terminalBuffer = terminalBuffer.slice(-TERMINAL_BUFFER_MAX);
          }
          if (term && currentView === "terminal") {
            term.write(msg.data);
          }
        }
        break;

      case "status":
        if (msg.connected) {
          setConnectionState("connected");
        }
        break;

      case "session_list":
        if (Array.isArray(msg.sessions)) {
          sessions = msg.sessions;
          // Validate restored activeSessionId still exists on the server
          if (activeSessionId && !sessions.some(function(s) { return s && s.sessionId === activeSessionId; })) {
            activeSessionId = sessions.length > 0 ? sessions[0].sessionId : null;
            messagesEl.innerHTML = "";
            messageLog = [];
            restoredFromCache = false;
            if (activeSessionId) restoreMessages(activeSessionId);
          }
          renderSessions();
        }
        break;

      case "session_switched":
        // Save messages for old session before switching
        saveMessages();
        // Clear active countdown intervals before wiping DOM
        activeCountdowns.forEach(function(id) { clearInterval(id); });
        activeCountdowns = [];
        activeSessionId = msg.sessionId;
        messagesEl.innerHTML = "";
        messageLog = [];
        restoredFromCache = false;
        restoreMessages(activeSessionId);
        // Clear terminal buffer for new session
        terminalBuffer = "";
        if (term) {
          try { term.clear(); } catch(e) {}
        }
        renderSessions();
        break;

      case "session_destroyed":
        // Clean up persisted messages for destroyed session
        if (msg.sessionId) {
          localStorage.removeItem(STORAGE_PREFIX + "messages_" + msg.sessionId);
        }
        break;

      case "conversations_list":
        renderConversations(msg.conversations);
        break;

      case "claude_ready":
        claudeReady = true;
        isBusy = false;
        removeThinking();
        updateBusyIndicator();
        updateButtons();
        break;

      case "history_replay_start":
        isReplay = true;
        userScrolledUp = true; // Don't auto-scroll during replay
        break;

      case "history_replay_end":
        isReplay = false;
        userScrolledUp = false;
        // Scroll to bottom after replay
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;

      case "message": {
        var messageType = msg.messageType || "response";
        if (messageType === "response" || messageType === "assistant") {
          addMessage("assistant", msg.content || "");
        } else if (messageType === "user_input") {
          addMessage("user", msg.content || "");
        } else if (messageType === "tool_use") {
          addToolBubble(msg.tool || "tool", msg.toolUseId || "", msg.toolInput || null);
        } else {
          addMessage("system", msg.content || "");
        }
        break;
      }

      case "stream_start": {
        streamingMsgId = msg.messageId;
        var streamDiv = document.createElement("div");
        streamDiv.className = "msg assistant";
        streamDiv.setAttribute("data-msg-id", sanitizeId(streamingMsgId));
        streamDiv.innerHTML = "";
        messagesEl.appendChild(streamDiv);
        removeThinking();
        isBusy = true;
        updateBusyIndicator();
        updateButtons();
        scrollToBottom();
        break;
      }

      case "stream_delta": {
        if (!msg.delta) break;
        var target = null;
        if (msg.messageId) {
          target = messagesEl.querySelector('[data-msg-id="' + sanitizeId(msg.messageId) + '"]');
        }
        if (!target && streamingMsgId) {
          target = messagesEl.querySelector('[data-msg-id="' + sanitizeId(streamingMsgId) + '"]');
        }
        if (target) {
          // Accumulate raw text, then re-render markdown
          var raw = target.getAttribute("data-raw") || "";
          raw += msg.delta;
          target.setAttribute("data-raw", raw);
          target.innerHTML = renderMarkdown(raw);
        }
        scrollToBottom();
        break;
      }

      case "stream_end": {
        // Log the completed streamed message
        if (streamingMsgId) {
          var streamEl = messagesEl.querySelector('[data-msg-id="' + sanitizeId(streamingMsgId) + '"]');
          if (streamEl) {
            var rawText = streamEl.getAttribute("data-raw") || streamEl.textContent || "";
            logMessage({ msgType: "assistant", content: rawText, timestamp: Date.now() });
          }
        }
        streamingMsgId = null;
        break;
      }

      case "tool_start":
        addToolBubble(msg.tool || "tool", msg.toolUseId || msg.messageId || "", msg.input || null);
        break;

      case "tool_result": {
        var toolId = msg.toolUseId || "";
        var toolEl = messagesEl.querySelector('[data-tool-id="' + sanitizeId(toolId) + '"]');
        if (toolEl) {
          var resultDiv = toolEl.querySelector(".tool-result");
          if (resultDiv) {
            resultDiv.textContent = msg.result || "";
            if (msg.truncated) {
              resultDiv.textContent += "\n[truncated]";
            }
          }
        }
        // Update messageLog entry with result
        for (var ri = messageLog.length - 1; ri >= 0; ri--) {
          if (messageLog[ri].type === "tool" && messageLog[ri].toolUseId === toolId) {
            messageLog[ri].result = msg.result || "";
            debouncedSave();
            break;
          }
        }
        break;
      }

      case "permission_request":
        addPermissionPrompt(msg.requestId, msg.tool || "Unknown", msg.description || "", msg.remainingMs);
        // Desktop notification when tab not focused
        if (!document.hasFocus() && "Notification" in window && Notification.permission === "granted") {
          var permNote = new Notification("Chroxy: Permission Required", {
            body: (msg.tool || "Tool") + ": " + (msg.description || "").slice(0, 100),
            tag: "chroxy-permission-" + msg.requestId,
            requireInteraction: true
          });
          permNote.onclick = function() { window.focus(); };
        }
        break;

      case "user_question": {
        if (Array.isArray(msg.questions) && msg.questions.length > 0) {
          var q = msg.questions[0];
          var questionOptions = Array.isArray(q.options) ? q.options : null;
          addQuestionPrompt(q.question || "Question from Claude", msg.toolUseId || "", questionOptions);
          // Desktop notification when tab not focused
          if (!document.hasFocus() && "Notification" in window && Notification.permission === "granted") {
            var qNote = new Notification("Chroxy: Question from Claude", {
              body: (q.question || "").slice(0, 100),
              tag: "chroxy-question-" + (msg.toolUseId || Date.now()),
              requireInteraction: true
            });
            qNote.onclick = function() { window.focus(); };
          }
        }
        break;
      }

      case "model_changed":
        activeModel = msg.model || null;
        statusModel = activeModel || "";
        updateModelSelect();
        updateStatusBar();
        break;

      case "available_models":
        if (Array.isArray(msg.models)) {
          availableModels = msg.models;
          updateModelSelect();
        }
        break;

      case "permission_mode_changed":
        permissionMode = msg.mode || "approve";
        permissionSelect.value = permissionMode;
        break;

      case "confirm_permission_mode": {
        var targetMode = msg.mode || "approve";
        var warning = msg.message || "Enable " + targetMode + " mode? Tools may run without approval.";
        if (window.confirm(warning)) {
          send({ type: "set_permission_mode", mode: targetMode, confirmed: true });
        } else {
          permissionSelect.value = permissionMode;
        }
        break;
      }

      case "available_permission_modes":
        if (Array.isArray(msg.modes) && msg.modes.length > 0) {
          var previousValue = permissionSelect.value;
          permissionSelect.innerHTML = "";
          msg.modes.forEach(function(m) {
            var opt = document.createElement("option");
            opt.value = m.id || m;
            opt.textContent = m.label || m.id || m;
            permissionSelect.appendChild(opt);
          });
          permissionSelect.value = previousValue;
          if (!permissionSelect.value) permissionSelect.value = permissionMode;
        }
        break;

      case "agent_busy":
        isBusy = true;
        showThinking();
        updateBusyIndicator();
        updateButtons();
        break;

      case "agent_idle":
        isBusy = false;
        removeThinking();
        updateBusyIndicator();
        updateButtons();
        // Notify if window not focused
        if (!document.hasFocus() && "Notification" in window && Notification.permission === "granted") {
          var idleNote = new Notification("Chroxy: Claude is waiting", {
            body: "Claude is waiting for input.",
            tag: "chroxy-idle"
          });
          idleNote.onclick = function() { window.focus(); };
        }
        break;

      case "error":
      case "server_error":
        addMessage("error", msg.message || msg.details || "Unknown error");
        showToast(msg.message || msg.details || "Unknown error");
        break;

      case "session_error":
        addMessage("error", msg.message || "Session error");
        showToast(msg.message || "Session error");
        break;

      case "server_shutdown":
        reconnectText.textContent = msg.reason === "restart"
          ? "Server restarting..."
          : msg.reason === "crash"
          ? "Server crashed. Reconnecting..."
          : "Server shutting down...";
        reconnectBanner.classList.remove("hidden");
        // Reset backoff for server-initiated restarts
        if (msg.reason === "restart") reconnectAttempt = 0;
        break;

      case "token_rotated":
        // Token was rotated — the new token is NOT sent over the wire.
        // Stop reconnect loop and show re-auth UI.
        reauthRequired = true;
        clearTimeout(reconnectTimer);
        reconnectBanner.classList.remove("hidden");
        reconnectText.textContent = "API token rotated. Enter the new token to reconnect:";
        reauthContainer.classList.remove("hidden");
        reconnectRetryBtn.classList.add("hidden");
        showToast("API token rotated — enter new token to re-authenticate");
        break;

      case "plan_started":
        inPlanMode = true;
        planModeBanner.classList.remove("hidden");
        planApprovalCard.classList.add("hidden");
        break;

      case "plan_ready":
        inPlanMode = false;
        planModeBanner.classList.add("hidden");
        planApprovalCard.classList.remove("hidden");
        if (msg.plan) {
          planContentEl.innerHTML = renderMarkdown(msg.plan);
        }
        break;

      case "agent_spawned":
        if (msg.agentId) {
          backgroundAgents.set(msg.agentId, { task: msg.task || "", startedAt: Date.now() });
          updateAgentBadge();
        }
        break;

      case "agent_completed":
        if (msg.agentId) {
          backgroundAgents.delete(msg.agentId);
          updateAgentBadge();
        }
        break;

      case "cost_update":
        if (typeof msg.sessionCost === "number") sessionCost = msg.sessionCost;
        if (typeof msg.totalCost === "number") totalCost = msg.totalCost;
        if (typeof msg.budget === "number") costBudget = msg.budget;
        statusCost = sessionCost;
        updateStatusBar();
        break;

      case "cost_summary":
        renderAnalytics(msg);
        break;

      case "result":
        if (typeof msg.cost === "number" && msg.cost > 0) {
          statusCost = msg.cost;
          updateStatusBar();
          recordCostEvent(msg.cost, msg.sessionId || activeSessionId, msg.duration || 0);
        }
        break;

      case "budget_warning":
        showToast("Budget warning: " + msg.message);
        break;

      case "budget_exceeded":
        showToast("Budget exceeded: " + msg.message);
        break;

      default:
        if (serverProtocolVersion != null && serverProtocolVersion > CLIENT_PROTOCOL_VERSION) {
          console.warn('[dashboard] Unknown message type "' + msg.type + '" (server protocol v' + serverProtocolVersion + ', client v' + CLIENT_PROTOCOL_VERSION + ')');
        }
        break;
    }
  }

  // ---- Input handling ----
  sendBtn.addEventListener("click", function() {
    sendInput(inputEl.value);
  });

  interruptBtn.addEventListener("click", function() {
    sendInterrupt();
  });

  reconnectRetryBtn.addEventListener("click", function() {
    reconnectAttempt = 0;
    reconnectRetryBtn.classList.add("hidden");
    reconnectText.textContent = "Reconnecting...";
    loadCostEvents();
  connect();
  });

  function submitReauth() {
    var newToken = reauthInput.value.trim();
    if (!newToken) return;
    token = newToken;
    reauthRequired = false;
    reauthContainer.classList.add("hidden");
    reauthInput.value = "";
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempt = 0;
    reconnectText.textContent = "Reconnecting with new token...";
    loadCostEvents();
  connect();
  }

  reauthSubmitBtn.addEventListener("click", submitReauth);
  reauthInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitReauth();
    }
  });

  inputEl.addEventListener("keydown", function(e) {
    // Ctrl+Enter or Cmd+Enter to send
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendInput(inputEl.value);
    }
  });

  document.addEventListener("keydown", function(e) {
    // Escape: close modal first, skip if renaming, otherwise interrupt
    if (e.key === "Escape") {
      if (modalOpen) {
        e.preventDefault();
        closeCreateSessionModal();
        return;
      }
      if (document.activeElement && document.activeElement.classList.contains("tab-rename-input")) {
        return;
      }
      e.preventDefault();
      sendInterrupt();
      return;
    }

    // Skip shortcuts when typing in inputs (except Escape handled above)
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    // Ctrl/Cmd+N: open new session modal
    if (e.key === "n" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      openCreateSessionModal();
      return;
    }

    // Ctrl+backtick: toggle chat/terminal view
    if (e.key === "\`" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      switchView(currentView === "chat" ? "terminal" : "chat");
      return;
    }

    // Ctrl/Cmd+1-9: switch to session by index
    if ((e.ctrlKey || e.metaKey) && e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      var idx = parseInt(e.key, 10) - 1;
      if (idx < sessions.length) {
        send({ type: "switch_session", sessionId: sessions[idx].sessionId });
      }
      return;
    }
  });

  // ---- Plan approval handlers ----
  planApproveBtn.addEventListener("click", function() {
    sendInput("Looks good, proceed.");
    planApprovalCard.classList.add("hidden");
  });

  planFeedbackBtn.addEventListener("click", function() {
    planApprovalCard.classList.add("hidden");
    inputEl.value = "Feedback on plan: ";
    inputEl.focus();
  });


  // ---- Cost analytics ----

  function loadCostEvents() {
    try {
      var json = localStorage.getItem(COST_STORAGE_KEY);
      if (json) costEvents = JSON.parse(json);
    } catch (e) {
      costEvents = [];
    }
  }

  function saveCostEvents() {
    try {
      localStorage.setItem(COST_STORAGE_KEY, JSON.stringify(costEvents));
    } catch (e) {}
  }

  function recordCostEvent(cost, sid, duration) {
    costEvents.push({
      sessionId: sid || "unknown",
      cost: cost,
      model: activeModel || "unknown",
      timestamp: Date.now(),
      duration: duration || 0,
    });
    if (costEvents.length > COST_EVENTS_MAX) {
      costEvents = costEvents.slice(costEvents.length - COST_EVENTS_MAX);
    }
    saveCostEvents();
  }

  function formatAnalyticsCost(n) {
    if (!n || n === 0) return "$0.00";
    if (n < 0.01) return "$" + n.toFixed(4);
    return "$" + n.toFixed(2);
  }

  function renderAnalytics(serverData) {
    if (!analyticsContent) return;

    // Merge server data with local events
    var total = serverData ? serverData.totalCost : totalCost;
    var budget = serverData ? serverData.budget : costBudget;
    var serverSessions = serverData ? serverData.sessions : [];

    // Summary cards
    var html = '<div class="analytics-cards">';
    html += '<div class="analytics-card"><div class="analytics-card-value">' + formatAnalyticsCost(total) + '</div><div class="analytics-card-label">Total Cost</div></div>';
    html += '<div class="analytics-card"><div class="analytics-card-value">' + (serverSessions.length || sessions.length) + '</div><div class="analytics-card-label">Sessions</div></div>';
    html += '<div class="analytics-card"><div class="analytics-card-value">' + costEvents.length + '</div><div class="analytics-card-label">Queries</div></div>';
    if (budget) {
      var pct = total && budget ? Math.round((total / budget) * 100) : 0;
      html += '<div class="analytics-card"><div class="analytics-card-value">' + formatAnalyticsCost(budget - (total || 0)) + '</div><div class="analytics-card-label">Budget Remaining (' + pct + '%)</div></div>';
    }
    html += '</div>';

    // Per-session cost breakdown (from server data)
    if (serverSessions.length > 0) {
      var sortedSessions = serverSessions.slice().sort(function(a, b) { return b.cost - a.cost; });
      var maxCost = sortedSessions[0].cost || 1;

      html += '<h4 class="analytics-section-title">Cost by Session</h4>';
      html += '<div class="analytics-bars">';
      for (var i = 0; i < sortedSessions.length; i++) {
        var s = sortedSessions[i];
        var barWidth = maxCost > 0 ? Math.max(2, Math.round((s.cost / maxCost) * 100)) : 0;
        html += '<div class="analytics-bar-row">';
        html += '<span class="analytics-bar-label">' + escapeHtml(s.name || s.sessionId.slice(0, 8)) + '</span>';
        html += '<div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:' + barWidth + '%"></div></div>';
        html += '<span class="analytics-bar-value">' + formatAnalyticsCost(s.cost) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Model usage breakdown (from local events)
    if (costEvents.length > 0) {
      var modelCosts = {};
      for (var j = 0; j < costEvents.length; j++) {
        var m = costEvents[j].model || "unknown";
        modelCosts[m] = (modelCosts[m] || 0) + costEvents[j].cost;
      }
      var modelEntries = Object.keys(modelCosts).map(function(k) { return { model: k, cost: modelCosts[k] }; });
      modelEntries.sort(function(a, b) { return b.cost - a.cost; });

      html += '<h4 class="analytics-section-title">Cost by Model</h4>';
      html += '<div class="analytics-bars">';
      var maxModelCost = modelEntries[0].cost || 1;
      for (var mi = 0; mi < modelEntries.length; mi++) {
        var me = modelEntries[mi];
        var mBarWidth = maxModelCost > 0 ? Math.max(2, Math.round((me.cost / maxModelCost) * 100)) : 0;
        html += '<div class="analytics-bar-row">';
        html += '<span class="analytics-bar-label">' + escapeHtml(me.model) + '</span>';
        html += '<div class="analytics-bar-track"><div class="analytics-bar-fill analytics-bar-fill-model" style="width:' + mBarWidth + '%"></div></div>';
        html += '<span class="analytics-bar-value">' + formatAnalyticsCost(me.cost) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Cost timeline (hourly, from local events)
    if (costEvents.length > 1) {
      var hourBuckets = {};
      for (var h = 0; h < costEvents.length; h++) {
        var d = new Date(costEvents[h].timestamp);
        var hourKey = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") + ":00";
        hourBuckets[hourKey] = (hourBuckets[hourKey] || 0) + costEvents[h].cost;
      }
      var hourKeys = Object.keys(hourBuckets).sort();
      if (hourKeys.length > 1) {
        var maxHourCost = 0;
        for (var hk = 0; hk < hourKeys.length; hk++) {
          if (hourBuckets[hourKeys[hk]] > maxHourCost) maxHourCost = hourBuckets[hourKeys[hk]];
        }
        html += '<h4 class="analytics-section-title">Cost Over Time</h4>';
        html += '<div class="analytics-timeline">';
        for (var tk = 0; tk < hourKeys.length; tk++) {
          var barHeight = maxHourCost > 0 ? Math.max(4, Math.round((hourBuckets[hourKeys[tk]] / maxHourCost) * 100)) : 0;
          html += '<div class="analytics-timeline-bar" title="' + hourKeys[tk] + ': ' + formatAnalyticsCost(hourBuckets[hourKeys[tk]]) + '">';
          html += '<div class="analytics-timeline-fill" style="height:' + barHeight + '%"></div>';
          html += '</div>';
        }
        html += '</div>';
        html += '<div class="analytics-timeline-labels"><span>' + hourKeys[0].split(" ")[1] + '</span><span>' + hourKeys[hourKeys.length - 1].split(" ")[1] + '</span></div>';
      }
    }

    if (costEvents.length === 0 && serverSessions.length === 0) {
      html += '<div style="text-align:center;color:#888;padding:32px 0;">No cost data yet. Send some messages to start tracking.</div>';
    }

    analyticsContent.innerHTML = html;
  }

  function exportCostCsv() {
    if (costEvents.length === 0) {
      showToast("No cost data to export");
      return;
    }
    var csv = "timestamp,session_id,model,cost,duration_ms\n";
    for (var i = 0; i < costEvents.length; i++) {
      var e = costEvents[i];
      csv += new Date(e.timestamp).toISOString() + "," + e.sessionId + "," + e.model + "," + e.cost + "," + (e.duration || 0) + "\n";
    }
    var blob = new Blob([csv], { type: "text/csv" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "chroxy-cost-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Analytics modal handlers ----

  if (analyticsBtn) {
    analyticsBtn.addEventListener("click", function() {
      analyticsModal.classList.remove("hidden");
      modalOpen = true;
      // Request fresh data from server
      send({ type: "request_cost_summary" });
      // Also render with local data immediately
      renderAnalytics(null);
    });
  }

  if (analyticsCloseBtn) {
    analyticsCloseBtn.addEventListener("click", function() {
      analyticsModal.classList.add("hidden");
      modalOpen = false;
    });
  }

  if (analyticsExportBtn) {
    analyticsExportBtn.addEventListener("click", exportCostCsv);
  }

  // ---- Init ----
  updateButtons();
  updateBusyIndicator();

  // Defer notification permission request until first user interaction
  if ("Notification" in window && Notification.permission === "default") {
    var requestNotifOnce = function() {
      document.removeEventListener("click", requestNotifOnce);
      document.removeEventListener("keydown", requestNotifOnce);
      Notification.requestPermission().catch(function() {});
    };
    document.addEventListener("click", requestNotifOnce);
    document.addEventListener("keydown", requestNotifOnce);
  }

  // Flush pending saves before page unload
  window.addEventListener("beforeunload", function() { saveMessages(); saveCostEvents(); });

  // Restore last active session ID and messages
  var savedSessionId = localStorage.getItem(STORAGE_PREFIX + "active_session");
  if (savedSessionId) {
    activeSessionId = savedSessionId;
    restoreMessages(activeSessionId);
  }

  loadCostEvents();
  connect();
})();
