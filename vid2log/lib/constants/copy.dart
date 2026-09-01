/// Plain-language copy for non-technical users (researchers with no ML/dev
/// background) — sidebar tooltips, page subtitles, tab tooltips, and key
/// action-button tooltips. Mirrors frontend/lib/copy.ts exactly so the web
/// app and this desktop app read identically. Keep them in sync when
/// editing either one.
///
/// Word choices made here on purpose (do not "fix" these back to the
/// technical terms):
///   Model            -> Detector      (the trained classifier)
///   Job (video)      -> Recording     (a video being processed)
///   Job (training)   -> Training session
///   Job (discovery)  -> Scan
///   Action dataset   -> Action set
///   SPM / DSM        -> kept as-is (proper analytics terms) — tooltip only
///                        says what the tab shows, not what SPM/DSM means.
library;

import '../shell/section.dart' show AppSection;

/// Sidebar item -> 3-5 word description shown on hover.
const Map<AppSection, String> kNavTooltips = {
  AppSection.dashboard: 'Overview of your activity',
  AppSection.createActions: 'Auto-find or define actions',
  AppSection.train: 'Teach a new detector',
  AppSection.detectors: 'Manage your trained detectors',
  AppSection.process: 'Upload and process recordings',
  AppSection.videoLogs: 'View generated activity logs',
  AppSection.analytics: 'Explore patterns across recordings',
  AppSection.help: 'Guides for every page',
};

/// One-line subtitle shown directly below each page's main title.
const Map<String, String> kPageSubtitles = {
  'dashboard': 'A quick look at your recordings, detectors, and recent activity.',
  'process': 'Process a screen recording and see what happened, moment by moment.',
  'video-logs': 'Browse the activity logs generated from your recordings.',
  'train': 'Teach a detector to recognize the actions in your recordings.',
  'detectors': 'Manage and compare the detectors you\'ve trained.',
  'create-actions': 'Let Vid2Log find repeated actions automatically, or define them yourself.',
  'analytics': 'Explore patterns and compare behavior across your recordings.',
  'help': 'Step-by-step guides for every part of Vid2Log.',
};

const Map<String, String> kProcessTabTooltips = {
  'new': 'Submit a new recording',
  'history': 'See past recordings',
};

const Map<String, String> kTrainTabTooltips = {
  'train': 'Start teaching a detector',
  'jobs': 'See training progress, results',
};

const Map<String, String> kDashboardTabTooltips = {
  'overview': 'Summary of recent activity',
  'detectors': 'Your trained detectors',
  'activity': 'Recent recordings and sessions',
};

const Map<String, String> kCreateActionsTabTooltips = {
  'discover': 'Scan a video for actions',
  'saved': 'Your saved action sets',
};

// Keeping "SPM"/"DSM" in the tab LABEL (proper analytics terms) — these
// tooltips describe what each tab shows in plain language instead.
const Map<String, String> kAnalyticsTabTooltips = {
  'overview': 'Summary across selected recordings',
  'spm': 'Compare recurring action patterns',
  'dsm': 'Compare two recording groups',
  'timeline': 'Actions plotted over time',
};

const Map<String, String> kButtonTooltips = {
  'retry': 'Try this recording again',
  'retrain': 'Teach this detector again',
  'activate': 'Make this the active detector',
  'merge': 'Combine two actions together',
  'addAction': 'Create a new action group',
  'exportCsv': 'Download as spreadsheet file',
  'downloadPdf': 'Download full report',
  'importCsv': 'Load an existing log',
  'help': 'How this page works',
};

/// Explanations for individual form fields, shown on the small info icon
/// beside a field's label (see widgets/ui.dart's FieldLabel). Mirrors
/// FIELD_TOOLTIPS in frontend/lib/copy.ts.
///
/// These exist because several inputs are named after a real parameter that a
/// researcher without an ML background cannot be expected to guess: 'Max
/// pattern length', 'S-support threshold', 'Learning rate'. Renaming those
/// would make the app harder to reconcile with the literature, so the name
/// stays and the tooltip carries the plain-language meaning instead.
///
/// Kept to roughly six words. Anything longer belongs in the relevant section
/// of constants/help_content.dart, which the `?` beside the page title opens.
const Map<String, String> kFieldTooltips = {
  // Train
  'detectorName': 'A name you will recognise later',
  'epochs': 'How many passes over your examples',
  'batchSize': 'Examples looked at per step',
  'learningRate': 'Size of each correction while learning',
  'importActionSet': 'Reuse actions saved in Create actions',
  'actionName': 'What this action will be called',
  // Create actions
  'discoverVideo': 'The recording to scan for actions',
  'minCluster': 'Fewest frames to count as an action',
  // Process
  'processVideo': 'The recording to turn into a log',
  'detector': 'Which trained detector to apply',
  'fps': 'Frames examined per second of video',
  // Analytics
  'sSupport': 'Share of logs a pattern must appear in',
  'topK': 'How many top patterns to return',
  'sortBy': 'Which measure orders the results',
  'windowMin': 'Shortest pattern length to look for',
  'windowMax': 'Longest pattern length to look for',
  'minGap': 'Fewest other actions allowed between steps',
  'maxGap': 'Most other actions allowed between steps',
  'iSupport': 'Minimum average occurrences per log',
  'testType': 'Which statistical test compares the groups',
  'pValue': 'How strong a difference must be to count',
};
