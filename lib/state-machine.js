// ============================================
// content_calendar state machine
//
// Flow:
//   draft → planning_done → selected → copy_done → pending_review → approved → published
//                                                            ↓
//                                                         rejected → copy_done
//
// published is terminal (idempotent — no further transitions allowed).
// ============================================

const STATES = [
  'draft',
  'planning_done',
  'selected',
  'copy_done',
  'pending_review',
  'approved',
  'rejected',
  'published',
];

const TRANSITIONS = {
  draft: ['planning_done'],
  planning_done: ['selected'],
  selected: ['copy_done'],
  copy_done: ['pending_review'],
  pending_review: ['approved', 'rejected'],
  approved: ['published'],
  rejected: ['copy_done'],
  published: [],
};

function isValidStatus(status) {
  return typeof status === 'string' && STATES.includes(status);
}

function allowedTransitions(status) {
  if (!isValidStatus(status)) {
    throw new Error(
      `Invalid status: "${status}". Valid statuses: ${STATES.join(', ')}`
    );
  }
  return TRANSITIONS[status].slice();
}

function nextStatus(status) {
  const allowed = allowedTransitions(status);
  if (allowed.length === 0) return null;
  return allowed[0];
}

function transition(currentStatus, targetStatus) {
  if (!isValidStatus(currentStatus)) {
    throw new Error(
      `Invalid current status: "${currentStatus}". Valid statuses: ${STATES.join(', ')}`
    );
  }
  if (!isValidStatus(targetStatus)) {
    throw new Error(
      `Invalid target status: "${targetStatus}". Valid statuses: ${STATES.join(', ')}`
    );
  }
  const allowed = TRANSITIONS[currentStatus];
  if (allowed.length === 0) {
    throw new Error(
      `State "${currentStatus}" is terminal — cannot transition to "${targetStatus}"`
    );
  }
  if (!allowed.includes(targetStatus)) {
    throw new Error(
      `Invalid transition: "${currentStatus}" → "${targetStatus}". Allowed from "${currentStatus}": ${allowed.join(', ')}`
    );
  }
  return targetStatus;
}

module.exports = {
  STATES,
  TRANSITIONS,
  isValidStatus,
  allowedTransitions,
  nextStatus,
  transition,
};
