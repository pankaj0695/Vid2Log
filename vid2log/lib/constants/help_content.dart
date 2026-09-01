/// The application's official documentation, one section per screen,
/// mirroring `frontend/lib/helpContent.ts` so that both clients document the
/// product identically. Keep the two synchronised when editing either.
///
/// House style, matching the web file:
///   1. Formal register. Prefer 'select' over 'click', 'do not' over 'don't'.
///   2. No em dashes anywhere in user facing text. Use a colon to introduce,
///      a semicolon to join, parentheses to qualify, or a new sentence.
///   3. Terminology follows constants/copy.dart: detector, recording, action
///      set. SPM, DSM and the support measures are retained as established
///      analytical terms and defined at the point of use.
///
/// Two deliberate differences from the web version, both following from this
/// being the offline desktop build:
///   * There is no Administration section, as the desktop application is a
///     single local user with no accounts to administer.
///   * Only the figures that explain something the prose cannot are drawn.
///     The web page also wireframes individual screens; on the desktop those
///     screens are one selection away in the sidebar. The prose is identical.
library;

enum HelpFigure { workflow, metrics, spm, dsm, timeline }

class HelpStepGroup {
  const HelpStepGroup({this.heading, required this.items, this.figure});

  final String? heading;

  /// Rendered as a numbered list. The numbers correspond to the callout
  /// badges in the accompanying figure.
  final List<String> items;
  final HelpFigure? figure;
}

class HelpTerm {
  const HelpTerm(this.term, this.def);
  final String term;
  final String def;
}

class HelpSection {
  const HelpSection({
    required this.id,
    required this.nav,
    required this.title,
    required this.blurb,
    this.figure,
    this.groups = const [],
    this.terms = const [],
    this.termsHeading,
    this.note,
  });

  /// Matches the web application's URL fragment, and the value supplied as
  /// `helpSection` to PageHeader on the corresponding screen.
  final String id;
  final String nav;
  final String title;
  final String blurb;
  final HelpFigure? figure;
  final List<HelpStepGroup> groups;
  final List<HelpTerm> terms;
  final String? termsHeading;
  final String? note;
}

const String kHelpIntro =
    'This guide covers each part of Vid2Log in the order it appears in the '
    'sidebar. If you are new to the application, begin with Getting started; '
    'the remaining sections may be read in any order.';

const List<HelpSection> kHelpSections = [
  HelpSection(
    id: 'start',
    nav: 'Getting started',
    title: 'Getting started',
    blurb:
        'Vid2Log converts a screen recording into a labelled, timestamped log of '
        'the actions it contains, then provides tools to compare those logs and '
        'identify patterns across a study.',
    figure: HelpFigure.workflow,
    groups: [
      HelpStepGroup(
        heading: 'The complete workflow',
        items: [
          'Create actions: identify the repeated screens in a sample recording and assign each one a name.',
          'Train: build a detector from those named examples.',
          'Process video: run your recordings through the detector.',
          'Video logs: review, correct and export the resulting logs.',
          'Analytics: compare patterns across recordings.',
        ],
      ),
    ],
    note: 'Steps 1 and 2 are carried out once per study. Steps 3 to 5 are '
        'repeated for each new recording.',
  ),
  HelpSection(
    id: 'dashboard',
    nav: 'Dashboard',
    title: 'Dashboard',
    blurb:
        'A summary of your activity: the volume processed to date, the work '
        'currently running, and the items completed most recently.',
    groups: [
      HelpStepGroup(
        heading: 'Tabs on this screen',
        items: [
          'Overview: totals across all recordings processed on this machine.',
          'Detectors: your trained detectors at a glance.',
          'Activity: recordings in order, most recent first.',
        ],
      ),
    ],
    note: 'Exactly one detector is active at any time. The active detector is '
        'applied by default to new recordings.',
  ),
  HelpSection(
    id: 'create-actions',
    nav: 'Create actions',
    title: 'Create actions',
    blurb:
        'Rather than assembling example screenshots by hand, Vid2Log can analyse '
        'a single representative recording. It samples frames, groups visually '
        'similar screens, and proposes each group as a candidate action for you '
        'to name.',
    groups: [
      HelpStepGroup(
        heading: 'Discovering actions',
        items: [
          'Select a demonstration recording that contains every screen you intend to detect.',
          'Set Sampling FPS, the number of frames examined per second. A value of 2 is appropriate for most recordings.',
          'Set Minimum cluster size, the smallest number of frames in which a screen must appear to qualify as an action in its own right.',
          'Select Discover actions. The review screen opens automatically once processing completes.',
        ],
      ),
      HelpStepGroup(
        heading: 'Reviewing the proposed actions',
        items: [
          'Rename each group to a meaningful label, for example "Login screen" or "Search results".',
          'Select two or more groups and choose Merge selected where they represent the same screen.',
          'Drag a thumbnail from one group onto another to reassign a misfiled frame.',
          'Remove frames that do not belong using the close control on the thumbnail.',
          'Enter a name for the set and choose Save action set.',
        ],
      ),
    ],
    termsHeading: 'Settings on this screen',
    terms: [
      HelpTerm(
        'Minimum cluster size',
        'Reduce this value if distinct screens are being grouped together. '
            'Increase it if the results contain a large number of near duplicate actions.',
      ),
      HelpTerm(
        'Saved action sets',
        'Every set you have saved, available to view, edit or delete. These sets '
            'are the input to training.',
      ),
    ],
    note: 'An action set must retain at least two actions containing images, '
        'because a detector requires a minimum of two categories to distinguish '
        'between.',
  ),
  HelpSection(
    id: 'train',
    nav: 'Train',
    title: 'Train',
    blurb: 'Converts a saved action set into a trained detector.',
    groups: [
      HelpStepGroup(
        heading: 'Training a detector',
        items: [
          'Import a folder of examples, or a saved action set.',
          'Enter a name for the detector.',
          'Select Start training, then monitor progress on the Training sessions tab.',
        ],
      ),
    ],
    termsHeading: 'Advanced settings (optional)',
    terms: [
      HelpTerm('Epochs (default 20)',
          'The number of complete passes made over the training examples.'),
      HelpTerm('Batch size (default 16)',
          'The number of examples processed in each step.'),
      HelpTerm('Learning rate (default 0.001)',
          'The magnitude of the adjustment made at each step.'),
      HelpTerm(
        'Split (default 70/15/15)',
        'The proportion of images allocated to training, validation and testing. '
            'The test portion is excluded from training and tuning, so the reported '
            'accuracy is an independent measurement.',
      ),
    ],
    note: 'Each action requires at least three images so that it can be divided '
        'across all three splits. The number and variety of examples per action '
        'affect accuracy considerably more than any of the settings above.',
  ),
  HelpSection(
    id: 'detectors',
    nav: 'My detectors',
    title: 'My detectors',
    blurb:
        'Every detector you have trained. From this screen a detector may be '
        'activated, renamed or deleted.',
    groups: [
      HelpStepGroup(
        heading: 'Interpreting a detector\'s results',
        figure: HelpFigure.metrics,
        items: [
          'Select View details on a detector to display its measured performance.',
          'Compare the three result rows: image only, text only, and the two combined.',
          'Consult the confusion matrix to establish which actions are being mistaken for one another.',
        ],
      ),
    ],
    termsHeading: 'Reading the measurements',
    terms: [
      HelpTerm('CNN-only', 'Classifies the screen using its pixels alone.'),
      HelpTerm('OCR text-only', 'Classifies the screen using the on-screen text alone.'),
      HelpTerm(
        'Combined',
        'Uses both sources, and is the configuration applied during processing. '
            'Fusion alpha indicates the weight given to the image; a value of 1.0 '
            'relies on the image alone.',
      ),
      HelpTerm('Precision',
          'Of the occasions on which the detector reported an action, the proportion that were correct.'),
      HelpTerm('Recall',
          'Of the actual occurrences of an action, the proportion the detector identified.'),
      HelpTerm('F1', 'A single figure combining precision and recall.'),
      HelpTerm(
        'Confusion matrix',
        'Rows represent the true action and columns the predicted action. Values '
            'on the diagonal are correct predictions. A high value away from the '
            'diagonal indicates a pair of actions being confused.',
      ),
    ],
    note: 'Where insufficient legible on-screen text is present, only the '
        'CNN-only row is reported. This is expected for image heavy interfaces and '
        'does not indicate a fault.',
  ),
  HelpSection(
    id: 'process',
    nav: 'Process video',
    title: 'Process video',
    blurb: 'Runs a recording through a detector and produces the corresponding log.',
    groups: [
      HelpStepGroup(
        heading: 'Processing a recording',
        items: [
          'Select the video file. It is read directly from your disk and does not leave this machine.',
          'Select a detector, or retain the active detector.',
          'Set Sampling FPS. A value of 2 is appropriate for most work; increase it only for rapidly changing screens.',
          'Select Process video, then monitor progress on the Recording history tab.',
        ],
      ),
    ],
    termsHeading: 'Recording statuses',
    terms: [
      HelpTerm('Queued', 'Waiting for earlier work to complete.'),
      HelpTerm('Processing', 'Currently running.'),
      HelpTerm('Done', 'Complete. The log is available under Video logs.'),
      HelpTerm('Failed',
          'Processing did not complete. The reason is displayed on the recording itself.'),
    ],
    note: 'Longer recordings take proportionally longer to process. You may move '
        'to another screen and return at any point, as processing continues '
        'independently.',
  ),
  HelpSection(
    id: 'video-logs',
    nav: 'Video logs',
    title: 'Video logs',
    blurb:
        'Every completed log. Expanding a log displays its scene table, listing '
        'start time, end time, duration, action and confidence.',
    groups: [
      HelpStepGroup(
        heading: 'Operations available on this screen',
        items: [
          'Download CSV: export a log for use in Excel, SPSS, R or a comparable tool.',
          'Import CSV log: load a log produced elsewhere, or one previously exported and corrected.',
          'CSV template: download this first to confirm the columns an import requires.',
          'Rename: give a log a label you will recognise later in Analytics.',
        ],
      ),
    ],
    termsHeading: 'Columns in the scene table',
    terms: [
      HelpTerm('Scene',
          'A continuous period during which a single action is detected, with a start and an end time.'),
      HelpTerm('Confidence',
          'The detector\'s certainty for that scene, expressed as a percentage.'),
    ],
    note: 'Persistently low confidence for one particular action generally '
        'indicates that the detector requires additional training examples for it.',
  ),
  HelpSection(
    id: 'analytics',
    nav: 'Analytics',
    title: 'Analytics',
    blurb:
        'The analysis tools. Each tab requires you to select the logs to include, '
        'so every figure produced describes a set you have chosen explicitly.',
    groups: [
      HelpStepGroup(
        heading: 'Overview',
        items: [
          'Reports totals, time spent per action, scenes per log, and the method by which each label was determined.',
          'The complete report may be exported as a CSV file or as a formatted PDF.',
        ],
      ),
      HelpStepGroup(
        heading: 'Sequential patterns (SPM)',
        figure: HelpFigure.spm,
        items: [
          'Identifies sequences of actions that recur across the selected logs, such as common workflows, loops and repeated work.',
          'At least two logs must be selected, as patterns are identified across logs rather than within a single log.',
          'If no results are returned, reduce the S-support threshold or widen the pattern length range.',
        ],
      ),
      HelpStepGroup(
        heading: 'Differential patterns (DSM)',
        figure: HelpFigure.dsm,
        items: [
          'Compares two groups of logs, for example expert against novice sessions, and reports the patterns that differ to a statistically significant degree.',
          'Assign logs to Group A and Group B. A log cannot belong to both groups.',
          'Each result is labelled with the group it characterises.',
        ],
      ),
      HelpStepGroup(
        heading: 'Video timeline',
        figure: HelpFigure.timeline,
        items: [
          'Displays each selected log\'s actions positioned along elapsed time, so that pacing and gaps are directly visible.',
          'Each action retains a consistent colour throughout the screen.',
        ],
      ),
    ],
    termsHeading: 'Statistical measures',
    terms: [
      HelpTerm('S-support',
          'The proportion of the selected logs in which the pattern occurs at least once.'),
      HelpTerm(
        'I-support',
        'The average number of occurrences per log, including those logs in which '
            'the pattern does not occur at all.',
      ),
      HelpTerm('p-value threshold (default 0.1)',
          'Determines how strict the significance test is in DSM. Lower values are stricter.'),
    ],
    note: 'SPM answers the question "what occurs frequently?". DSM answers "what '
        'differs between these two groups?". Use SPM first to establish the '
        'vocabulary of your data, then DSM to test a specific hypothesis about it.',
  ),
  HelpSection(
    id: 'glossary',
    nav: 'Glossary',
    title: 'Glossary',
    blurb: 'The terms Vid2Log uses for its own concepts.',
    termsHeading: 'Terms used throughout the application',
    terms: [
      HelpTerm('Action',
          'A single meaningful screen or activity, for example "Login screen".'),
      HelpTerm('Detector',
          'The trained model that identifies your actions within a recording.'),
      HelpTerm('Action set',
          'The named collection of example images from which a detector is trained.'),
      HelpTerm('Recording', 'A video that has been processed on this machine.'),
      HelpTerm('Scene',
          'A continuous period within a recording during which one action is detected.'),
      HelpTerm('Confidence',
          'The detector\'s certainty for a given scene, expressed as a percentage.'),
      HelpTerm('Active detector',
          'The detector applied by default to new recordings. Exactly one is active at any time.'),
    ],
  ),
  HelpSection(
    id: 'troubleshooting',
    nav: 'Troubleshooting',
    title: 'Troubleshooting',
    blurb: 'The conditions encountered most frequently, and the action to take in each case.',
    termsHeading: 'Common conditions',
    terms: [
      HelpTerm('Training does not start',
          'At least two actions are required, each containing at least three images.'),
      HelpTerm(
        'A recording failed',
        'Open the recording under Recording history to view the reason. Large '
            'files take longer to process but should still complete.',
      ),
      HelpTerm(
        'Two actions are confused',
        'Consult the confusion matrix on the detector\'s detail screen, then add '
            'further examples, with greater variety, for the affected pair.',
      ),
      HelpTerm('SPM returns no results',
          'Reduce the S-support threshold, widen the pattern length range, or permit a larger maximum gap.'),
      HelpTerm('DSM returns no results',
          'Increase the p-value threshold, or compare two groups that differ more substantially from each other.'),
      HelpTerm(
        'A log contains errors',
        'Export it as CSV, correct it, and import it again. Imported logs behave '
            'identically to generated logs in Analytics.',
      ),
    ],
  ),
];

/// Section identifiers, so that a screen may pass
/// `helpSection: kHelpAnchors.process` and a typo fails at the call site
/// rather than silently scrolling nowhere.
abstract final class kHelpAnchors {
  static const start = 'start';
  static const dashboard = 'dashboard';
  static const createActions = 'create-actions';
  static const train = 'train';
  static const detectors = 'detectors';
  static const process = 'process';
  static const videoLogs = 'video-logs';
  static const analytics = 'analytics';
}
