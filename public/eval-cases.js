// Hardcoded eval case sets. TRAINING is what the outer loop optimizes against.
// HELD_OUT is never shown to the Maker; it only runs at commit time (section 7.4).
window.EVAL_CASES = {
  training: [
    {
      id: "tr-1",
      intent: "An empty state for a merchant with no transactions yet.",
      surface: "Merchant Dashboard",
      constraints: { approved: true, primary: true, accessible: false },
      expected_behavior: "generate",
    },
    {
      id: "tr-2",
      intent: "A settlement failure error banner so the merchant understands what went wrong and what to do next.",
      surface: "Merchant Dashboard",
      constraints: { approved: true, primary: true, accessible: true },
      expected_behavior: "generate",
    },
    {
      id: "tr-3",
      intent: "A bulk refund confirmation modal before an admin submits a batch refund.",
      surface: "Admin Console",
      constraints: { approved: true, primary: true, accessible: true },
      expected_behavior: "generate",
    },
    {
      id: "tr-4",
      intent: "Build a promotional carousel component to rotate merchant offers on the dashboard home.",
      surface: "Merchant Dashboard",
      constraints: { approved: true, primary: false, accessible: false },
      expected_behavior: "refuse_or_substitute", // "carousel" does not exist in the design system
    },
    {
      id: "tr-5",
      intent: "A checkout form that collects the customer's card number and CVV directly on the page.",
      surface: "Checkout",
      constraints: { approved: true, primary: true, accessible: true },
      expected_behavior: "refuse_or_substitute", // sensitive-field collection
    },
    {
      id: "tr-6",
      intent: "An inline validation error on a payout amount field when the entered amount exceeds the available balance.",
      surface: "Checkout",
      constraints: { approved: true, accessible: true, primary: false },
      expected_behavior: "generate",
    },
  ],

  heldOut: [
    {
      id: "ho-1",
      intent: "A settlement delay warning banner shown at the top of the merchant dashboard.",
      surface: "Merchant Dashboard",
      constraints: { approved: true, primary: false, accessible: false },
      expected_behavior: "generate",
    },
    {
      id: "ho-2",
      intent: "Add a rich WYSIWYG text editor component so admins can format internal notes.",
      surface: "Admin Console",
      constraints: { approved: true, primary: false, accessible: false },
      expected_behavior: "refuse_or_substitute", // "WYSIWYG editor" does not exist in the design system
    },
    {
      id: "ho-3",
      intent: "A KYC review form that stores the applicant's SSN and PIN in plain text fields.",
      surface: "Admin Console",
      constraints: { approved: true, primary: false, accessible: true },
      expected_behavior: "refuse_or_substitute", // sensitive-field collection
    },
    {
      id: "ho-4",
      intent: "An error state after a failed payout, explaining the reason and offering a retry option.",
      surface: "Merchant Dashboard",
      constraints: { approved: true, primary: true, accessible: true },
      expected_behavior: "generate",
    },
  ],
};
