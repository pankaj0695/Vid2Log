/**
 * The application's official documentation, one section per page, ordered as
 * the sidebar is ordered.
 *
 * This is a DATA file on purpose. The `/help` page renders it, the `?` control
 * in every PageHeader links to a section by `id`, and the Flutter desktop
 * application mirrors it in `vid2log/lib/constants/help_content.dart` so that
 * both clients document the product identically. Keep the two synchronised
 * when editing either.
 *
 * House style for this file:
 *   1. Formal register. Prefer "select" over "click", "do not" over "don't".
 *   2. No em dashes anywhere. Use a colon to introduce, a semicolon to join,
 *      parentheses to qualify, or simply start a new sentence.
 *   3. Terminology follows lib/copy.ts: detector (not model), recording (not
 *      job), action set (not dataset). SPM, DSM and the support measures are
 *      retained because they are established analytical terms; each is
 *      defined at the point of use rather than renamed.
 */

/** Which diagram accompanies a section or step group. Keys correspond to the
 * components in components/help/HelpFigures.tsx. */
export type FigureKey =
  | "workflow"
  | "dashboard"
  | "discover"
  | "review"
  | "train"
  | "metrics"
  | "process"
  | "logs"
  | "spm"
  | "dsm"
  | "timeline";

export interface HelpStepGroup {
  heading?: string;
  /** Rendered as a numbered list. The numbers correspond to the callout
   * badges in the accompanying figure, so item 3 is badge 3 in the diagram. */
  items: string[];
  /** Placed directly beneath this group, so each diagram sits alongside the
   * steps it illustrates rather than collecting at the top of the section. */
  figure?: FigureKey;
}

export interface HelpTerm {
  term: string;
  def: string;
}

export interface HelpSection {
  /** URL fragment, for example /help#create-actions. Also the value supplied
   * as `helpAnchor` to PageHeader on the corresponding page. */
  id: string;
  /** Short label for the contents list. */
  nav: string;
  title: string;
  /** One or two sentences stating the purpose of the page. */
  blurb: string;
  figure?: FigureKey;
  groups?: HelpStepGroup[];
  /** Reference table for anything on the page that requires definition. */
  terms?: HelpTerm[];
  /** Heading for the reference table. Defaults to "Reference". */
  termsHeading?: string;
  /** A single closing qualification, presented as a note. */
  note?: string;
  /** True for sections that only some users can reach. */
  adminOnly?: boolean;
}

export const HELP_INTRO =
  "This guide covers each part of Vid2Log in the order it appears in the sidebar. If you are new to the application, begin with Getting started; the remaining sections may be read in any order.";

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: "start",
    nav: "Getting started",
    title: "Getting started",
    blurb:
      "Vid2Log converts a screen recording into a labelled, timestamped log of the actions it contains, then provides tools to compare those logs and identify patterns across a study.",
    figure: "workflow",
    groups: [
      {
        heading: "The complete workflow",
        items: [
          "Create actions: identify the repeated screens in a sample recording and assign each one a name.",
          "Train: build a detector from those named examples.",
          "Process video: run your recordings through the detector.",
          "Video logs: review, correct and export the resulting logs.",
          "Analytics: compare patterns across recordings.",
        ],
      },
    ],
    note: "Steps 1 and 2 are carried out once per study. Steps 3 to 5 are repeated for each new recording.",
  },
  {
    id: "dashboard",
    nav: "Dashboard",
    title: "Dashboard",
    blurb:
      "A summary of your activity: the volume processed to date, the work currently running, and the items completed most recently.",
    figure: "dashboard",
    groups: [
      {
        heading: "Tabs on this page",
        items: [
          "Overview: totals across all recordings, together with a 14 day processing chart.",
          "Detectors: your trained detectors, with the option to activate one without leaving the page.",
          "Activity: recordings and training sessions combined, most recent first.",
        ],
      },
    ],
    note: "Exactly one detector is active at any time. The active detector is applied by default to new recordings.",
  },
  {
    id: "create-actions",
    nav: "Create actions",
    title: "Create actions",
    blurb:
      "Rather than assembling example screenshots by hand, Vid2Log can analyse a single representative recording. It samples frames, groups visually similar screens, and proposes each group as a candidate action for you to name.",
    groups: [
      {
        heading: "Discovering actions",
        figure: "discover",
        items: [
          "Select a demonstration recording that contains every screen you intend to detect.",
          "Set Sampling FPS, the number of frames examined per second. A value of 2 is appropriate for most recordings.",
          "Set Minimum cluster size, the smallest number of frames in which a screen must appear to qualify as an action in its own right.",
          "Select Discover actions. The review screen opens automatically once processing completes.",
        ],
      },
      {
        heading: "Reviewing the proposed actions",
        figure: "review",
        items: [
          'Rename each group to a meaningful label, for example "Login screen" or "Search results".',
          "Select two or more groups and choose Merge selected where they represent the same screen.",
          "Drag a thumbnail from one group onto another to reassign a misfiled frame.",
          "Remove frames that do not belong using the close control on the thumbnail.",
          "Enter a name for the set and choose Save action set.",
        ],
      },
    ],
    termsHeading: "Settings on this page",
    terms: [
      {
        term: "Minimum cluster size",
        def: "Reduce this value if distinct screens are being grouped together. Increase it if the results contain a large number of near duplicate actions.",
      },
      {
        term: "Saved action sets",
        def: "Every set you have saved, available to view, edit or delete. These sets are the input to training.",
      },
    ],
    note: "An action set must retain at least two actions containing images, because a detector requires a minimum of two categories to distinguish between.",
  },
  {
    id: "train",
    nav: "Train",
    title: "Train",
    blurb: "Converts a saved action set into a trained detector.",
    groups: [
      {
        heading: "Training a detector",
        figure: "train",
        items: [
          "Import a saved action set, or add images to each action manually.",
          "Enter a name for the detector.",
          "Select Start training, then monitor progress on the Training sessions tab.",
        ],
      },
    ],
    termsHeading: "Advanced settings (optional)",
    terms: [
      {
        term: "Epochs (default 20)",
        def: "The number of complete passes made over the training examples.",
      },
      {
        term: "Batch size (default 16)",
        def: "The number of examples processed in each step.",
      },
      {
        term: "Learning rate (default 0.001)",
        def: "The magnitude of the adjustment made at each step.",
      },
      {
        term: "Split (default 70/15/15)",
        def: "The proportion of images allocated to training, validation and testing. The test portion is excluded from training and tuning, so the reported accuracy is an independent measurement.",
      },
    ],
    note: "Each action requires at least three images so that it can be divided across all three splits. The number and variety of examples per action affect accuracy considerably more than any of the settings above.",
  },
  {
    id: "detectors",
    nav: "My detectors",
    title: "My detectors",
    blurb:
      "Every detector you have trained. From this page a detector may be activated, renamed, deleted, or retrained with different settings.",
    groups: [
      {
        heading: "Interpreting a detector's results",
        figure: "metrics",
        items: [
          "Select View details on a detector to display its measured performance.",
          "Compare the three result rows: image only, text only, and the two combined.",
          "Consult the confusion matrix to establish which actions are being mistaken for one another.",
        ],
      },
    ],
    termsHeading: "Reading the measurements",
    terms: [
      { term: "CNN-only", def: "Classifies the screen using its pixels alone." },
      { term: "OCR text-only", def: "Classifies the screen using the on-screen text alone." },
      {
        term: "Combined",
        def: "Uses both sources, and is the configuration applied during processing. Fusion alpha indicates the weight given to the image; a value of 1.0 relies on the image alone.",
      },
      {
        term: "Precision",
        def: "Of the occasions on which the detector reported an action, the proportion that were correct.",
      },
      {
        term: "Recall",
        def: "Of the actual occurrences of an action, the proportion the detector identified.",
      },
      { term: "F1", def: "A single figure combining precision and recall." },
      {
        term: "Confusion matrix",
        def: "Rows represent the true action and columns the predicted action. Values on the diagonal are correct predictions. A high value away from the diagonal indicates a pair of actions being confused.",
      },
    ],
    note: "Where insufficient legible on-screen text is present, only the CNN-only row is reported. This is expected for image heavy interfaces and does not indicate a fault.",
  },
  {
    id: "process",
    nav: "Process video",
    title: "Process video",
    blurb: "Runs a recording through a detector and produces the corresponding log.",
    groups: [
      {
        heading: "Processing a recording",
        figure: "process",
        items: [
          "Upload the recording.",
          "Select a detector, or retain the active detector.",
          "Set Sampling FPS. A value of 2 is appropriate for most work; increase it only for rapidly changing screens.",
          "Select Process video, then monitor progress on the Recording history tab.",
        ],
      },
    ],
    termsHeading: "Recording statuses",
    terms: [
      { term: "Queued", def: "Waiting for earlier work to complete." },
      { term: "Processing", def: "Currently running." },
      { term: "Done", def: "Complete. The log is available under Video logs." },
      {
        term: "Failed",
        def: "Processing did not complete. The reason is displayed on the recording itself.",
      },
    ],
    note: "Longer recordings take proportionally longer to process. You may navigate away and return at any point, as processing continues independently of the page.",
  },
  {
    id: "video-logs",
    nav: "Video logs",
    title: "Video logs",
    blurb:
      "Every completed log. Expanding a log displays its scene table, listing start time, end time, duration, action and confidence.",
    groups: [
      {
        heading: "Operations available on this page",
        figure: "logs",
        items: [
          "Download CSV: export a log for use in Excel, SPSS, R or a comparable tool.",
          "Import CSV log: load a log produced elsewhere, or one previously exported and corrected.",
          "CSV template: download this first to confirm the columns an import requires.",
          "Rename: give a log a label you will recognise later in Analytics.",
        ],
      },
    ],
    termsHeading: "Columns in the scene table",
    terms: [
      {
        term: "Scene",
        def: "A continuous period during which a single action is detected, with a start and an end time.",
      },
      {
        term: "Confidence",
        def: "The detector's certainty for that scene, expressed as a percentage.",
      },
    ],
    note: "Persistently low confidence for one particular action generally indicates that the detector requires additional training examples for it.",
  },
  {
    id: "analytics",
    nav: "Analytics",
    title: "Analytics",
    blurb:
      "The analysis tools. Each tab requires you to select the logs to include, so every figure produced describes a set you have chosen explicitly.",
    groups: [
      {
        heading: "Overview",
        items: [
          "Reports totals, time spent per action, scenes per log, and the method by which each label was determined.",
          "The complete report may be exported as a CSV file or as a formatted PDF.",
        ],
      },
      {
        heading: "Sequential patterns (SPM)",
        figure: "spm",
        items: [
          "Identifies sequences of actions that recur across the selected logs, such as common workflows, loops and repeated work.",
          "At least two logs must be selected, as patterns are identified across logs rather than within a single log.",
          "If no results are returned, reduce the S-support threshold or widen the pattern length range.",
        ],
      },
      {
        heading: "Differential patterns (DSM)",
        figure: "dsm",
        items: [
          "Compares two groups of logs, for example expert against novice sessions, and reports the patterns that differ to a statistically significant degree.",
          "Assign logs to Group A and Group B. A log cannot belong to both groups.",
          "Each result is labelled with the group it characterises.",
        ],
      },
      {
        heading: "Video timeline",
        figure: "timeline",
        items: [
          "Displays each selected log's actions positioned along elapsed time, so that pacing and gaps are directly visible.",
          "Each action retains a consistent colour throughout the page.",
        ],
      },
    ],
    termsHeading: "Statistical measures",
    terms: [
      {
        term: "S-support",
        def: "The proportion of the selected logs in which the pattern occurs at least once.",
      },
      {
        term: "I-support",
        def: "The average number of occurrences per log, including those logs in which the pattern does not occur at all.",
      },
      {
        term: "p-value threshold (default 0.1)",
        def: "Determines how strict the significance test is in DSM. Lower values are stricter.",
      },
    ],
    note: 'SPM answers the question "what occurs frequently?". DSM answers "what differs between these two groups?". Use SPM first to establish the vocabulary of your data, then DSM to test a specific hypothesis about it.',
  },
  {
    id: "admin",
    nav: "Administration",
    title: "Administration",
    adminOnly: true,
    blurb:
      "Available to administrators only. Provides the user list with role assignment, system wide totals, and a storage cleanup operation for recordings left behind by a failed run.",
  },
  {
    id: "glossary",
    nav: "Glossary",
    title: "Glossary",
    blurb: "The terms Vid2Log uses for its own concepts.",
    termsHeading: "Terms used throughout the application",
    terms: [
      { term: "Action", def: 'A single meaningful screen or activity, for example "Login screen".' },
      {
        term: "Detector",
        def: "The trained model that identifies your actions within a recording.",
      },
      {
        term: "Action set",
        def: "The named collection of example images from which a detector is trained.",
      },
      { term: "Recording", def: "A video that has been uploaded for processing." },
      {
        term: "Scene",
        def: "A continuous period within a recording during which one action is detected.",
      },
      {
        term: "Confidence",
        def: "The detector's certainty for a given scene, expressed as a percentage.",
      },
      {
        term: "Active detector",
        def: "The detector applied by default to new recordings. Exactly one is active at any time.",
      },
    ],
  },
  {
    id: "troubleshooting",
    nav: "Troubleshooting",
    title: "Troubleshooting",
    blurb: "The conditions encountered most frequently, and the action to take in each case.",
    termsHeading: "Common conditions",
    terms: [
      {
        term: "Training does not start",
        def: "At least two actions are required, each containing at least three images.",
      },
      {
        term: "A recording failed",
        def: "Open the recording under Recording history to view the reason. Large files take longer to process but should still complete.",
      },
      {
        term: "Two actions are confused",
        def: "Consult the confusion matrix on the detector's detail page, then add further examples, with greater variety, for the affected pair.",
      },
      {
        term: "SPM returns no results",
        def: "Reduce the S-support threshold, widen the pattern length range, or permit a larger maximum gap.",
      },
      {
        term: "DSM returns no results",
        def: "Increase the p-value threshold, or compare two groups that differ more substantially from each other.",
      },
      {
        term: "A log contains errors",
        def: "Export it as CSV, correct it, and import it again. Imported logs behave identically to generated logs in Analytics.",
      },
    ],
  },
];

/** Anchor identifiers, so that a page may pass `helpAnchor={HELP_ANCHORS.process}`
 * and receive a compile time error should a section ever be renamed or removed. */
export const HELP_ANCHORS = {
  start: "start",
  dashboard: "dashboard",
  createActions: "create-actions",
  train: "train",
  detectors: "detectors",
  process: "process",
  videoLogs: "video-logs",
  analytics: "analytics",
  admin: "admin",
} as const;
