// Mock design system — treated as ground truth everywhere in this app.
// In production this file is generated from the design system's published
// TypeScript types on every release; nothing here is hand-copied into the evaluator.
window.DESIGN_SYSTEM = {
  components: [
    {
      name: "Button",
      props: {
        variant: ["primary", "secondary", "tertiary", "destructive"],
        size: ["small", "medium", "large"],
        disabled: ["true", "false"],
      },
      variants: ["primary", "secondary", "tertiary", "destructive"],
      usageRule: "Use primary for the single main action per screen; never show more than one primary Button at once.",
    },
    {
      name: "Input",
      props: {
        type: ["text", "number", "email", "currency"],
        state: ["default", "error", "disabled"],
        size: ["small", "medium"],
      },
      variants: ["default", "error", "disabled"],
      usageRule: "Always pair with a visible label; never rely on placeholder text as the only label.",
    },
    {
      name: "Card",
      props: {
        padding: ["compact", "comfortable"],
        elevation: ["flat", "raised"],
      },
      variants: ["flat", "raised"],
      usageRule: "Use to group related content into one visually bounded unit; avoid nesting Cards inside Cards.",
    },
    {
      name: "Table",
      props: {
        density: ["compact", "comfortable"],
        sortable: ["true", "false"],
      },
      variants: ["compact", "comfortable"],
      usageRule: "Use for tabular multi-row data with consistent columns; pair with an EmptyState for the zero-row case.",
    },
    {
      name: "Modal",
      props: {
        size: ["small", "medium", "large"],
        dismissible: ["true", "false"],
      },
      variants: ["small", "medium", "large"],
      usageRule: "Reserve for actions that require full attention before continuing; never stack two Modals.",
    },
    {
      name: "Badge",
      props: {
        tone: ["neutral", "success", "warning", "danger", "info"],
      },
      variants: ["neutral", "success", "warning", "danger", "info"],
      usageRule: "Use for short status labels only, never for interactive content.",
    },
    {
      name: "Alert",
      props: {
        tone: ["info", "success", "warning", "danger"],
        dismissible: ["true", "false"],
      },
      variants: ["info", "success", "warning", "danger"],
      usageRule: "Use for contextual feedback tied to a specific section; a danger Alert must pair with a next-step action.",
    },
    {
      name: "Banner",
      props: {
        tone: ["info", "warning", "danger"],
        placement: ["page-top", "section"],
      },
      variants: ["info", "warning", "danger"],
      usageRule: "Use for page-level or system-wide messages, not for feedback scoped to a single field.",
    },
    {
      name: "EmptyState",
      props: {
        hasAction: ["true", "false"],
      },
      variants: ["default", "compact"],
      usageRule: "Always shown when a Table or list has zero rows; explain why it's empty and offer a next step.",
    },
    {
      name: "Tooltip",
      props: {
        placement: ["top", "bottom", "left", "right"],
      },
      variants: ["default"],
      usageRule: "Use only for supplementary clarification, never for content required to complete a task.",
    },
    {
      name: "Select",
      props: {
        multiple: ["true", "false"],
        state: ["default", "error", "disabled"],
      },
      variants: ["default", "error", "disabled"],
      usageRule: "Use when choosing from a bounded list of 4+ options; use Checkbox for binary choices.",
    },
    {
      name: "Checkbox",
      props: {
        state: ["unchecked", "checked", "indeterminate"],
      },
      variants: ["default", "disabled"],
      usageRule: "Use for binary or multi-select toggles within a form; never use for navigation.",
    },
  ],

  tokens: [
    { name: "space-xs", category: "spacing" },
    { name: "space-sm", category: "spacing" },
    { name: "space-md", category: "spacing" },
    { name: "space-lg", category: "spacing" },
    { name: "color-primary", category: "color" },
    { name: "color-neutral", category: "color" },
    { name: "color-success", category: "color" },
    { name: "color-danger", category: "color" },
  ],

  // Substring match, case-insensitive, checked against every entry in a
  // generation's field_names.
  blocklist: [
    "card number",
    "cvv",
    "password",
    "ssn",
    "aadhaar",
    "account number",
    "pin",
  ],
};
