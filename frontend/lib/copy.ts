/**
 * Plain-language copy for non-technical users (researchers with no ML/dev
 * background) — sidebar tooltips, page subtitles, tab tooltips, and key
 * action-button tooltips. This is the single canonical wording source for
 * the WEB app; the Flutter desktop app mirrors this exact copy in
 * `vid2log/lib/constants/copy.dart` so both apps read identically. Keep
 * them in sync when editing either one.
 *
 * Word choices made here on purpose (do not "fix" these back to the
 * technical terms):
 *   Model            -> Detector      (the trained classifier)
 *   Job (video)       -> Recording     (an uploaded video being processed)
 *   Job (training)    -> Training session
 *   Job (discovery)   -> Scan
 *   Action dataset    -> Action set
 *   SPM / DSM         -> kept as-is (proper analytics terms) — tooltip only
 *                         says what the tab shows, not what SPM/DSM means.
 */

export const NAV_TOOLTIPS: Record<string, string> = {
  dashboard: "Overview of your activity",
  "create-actions": "Auto-find or define actions",
  train: "Teach a new detector",
  detectors: "Manage your trained detectors",
  process: "Upload and process recordings",
  "video-logs": "View generated activity logs",
  analytics: "Explore patterns across recordings",
  admin: "Manage users and access",
  help: "Guides for every page",
};

export const PAGE_SUBTITLES: Record<string, string> = {
  dashboard: "A quick look at your recordings, detectors, and recent activity.",
  process: "Upload a screen recording and see what happened, moment by moment.",
  "video-logs": "Browse the activity logs generated from your recordings.",
  train: "Teach a detector to recognize the actions in your recordings.",
  detectors: "Manage and compare the detectors you've trained.",
  "detector-detail": "Details, performance, and options for this detector.",
  "create-actions": "Let Vid2Log find repeated actions automatically, or define them yourself.",
  analytics: "Explore patterns and compare behavior across your recordings.",
  admin: "Manage who has access and what they can do.",
  help: "Step-by-step guides for every part of Vid2Log.",
};

export const TAB_TOOLTIPS = {
  process: {
    new: "Submit a new recording",
    history: "See past recordings",
  },
  train: {
    train: "Start teaching a detector",
    jobs: "See training progress, results",
  },
  dashboard: {
    overview: "Summary of recent activity",
    detectors: "Your trained detectors",
    activity: "Recent recordings and sessions",
  },
  createActions: {
    discover: "Scan a video for actions",
    saved: "Your saved action sets",
  },
  analytics: {
    // Keeping "SPM"/"DSM" in the tab LABEL (proper analytics terms) — these
    // tooltips describe what each tab shows in plain language instead.
    overview: "Summary across selected recordings",
    spm: "Compare recurring action patterns",
    dsm: "Compare two recording groups",
    timeline: "Actions plotted over time",
  },
  admin: {
    overview: "Summary of admin activity",
    users: "Manage user accounts, roles",
  },
} as const;

export const BUTTON_TOOLTIPS = {
  retry: "Try this recording again",
  retrain: "Teach this detector again",
  activate: "Make this the active detector",
  merge: "Combine two actions together",
  addAction: "Create a new action group",
  exportCsv: "Download as spreadsheet file",
  downloadPdf: "Download full report",
  importCsv: "Load an existing log",
  help: "How this page works",
} as const;

/**
 * Explanations for individual form fields, shown on the small info icon
 * beside a field's label (see components/ui/Input.tsx's Label).
 *
 * These exist because several inputs are named after a real parameter that a
 * researcher without an ML background cannot be expected to guess: "Sliding
 * Window Max", "S Support Threshold", "Learning rate". Renaming those would
 * make the app harder to reconcile with the literature, so the name stays and
 * the tooltip carries the plain-language meaning instead.
 *
 * Kept to roughly six words. Anything needing more than that belongs in the
 * relevant section of lib/helpContent.ts, which the `?` beside the page title
 * links to.
 */
export const FIELD_TOOLTIPS = {
  train: {
    detectorName: "A name you will recognise later",
    epochs: "How many passes over your examples",
    batchSize: "Examples looked at per step",
    learningRate: "Size of each correction while learning",
    split: "How images divide into train, validation, test",
    importActionSet: "Reuse actions saved in Create actions",
    actionName: "What this action will be called",
  },
  createActions: {
    video: "The recording to scan for actions",
    fps: "Frames examined per second of video",
    minCluster: "Fewest frames to count as an action",
  },
  process: {
    video: "The recording to turn into a log",
    detector: "Which trained detector to apply",
    fps: "Frames examined per second of video",
  },
  detectors: {
    rename: "A name you will recognise later",
  },
  analytics: {
    sSupport: "Share of logs a pattern must appear in",
    topK: "How many top patterns to return",
    sortBy: "Which measure orders the results",
    windowMin: "Shortest pattern length to look for",
    windowMax: "Longest pattern length to look for",
    minGap: "Fewest other actions allowed between steps",
    maxGap: "Most other actions allowed between steps",
    iSupport: "Minimum average occurrences per log",
    testType: "Which statistical test compares the groups",
    pValue: "How strong a difference must be to count",
  },
} as const;
