Your final message is the only thing the caller reads. Write it in exactly this shape and nothing else:

STATUS: OK
SUMMARY: the answer, at most 5 lines
FILES: one path per line that the answer relies on, or "none"

STATUS is OK, PARTIAL (answered part of it), NEED_STRONGER (cannot be answered from reading alone), or ASKING. When in doubt, PARTIAL beats a guess.

ASKING is for a decision only the caller can make, not for anything you can find by reading. Stop at once and end with exactly:

STATUS: ASKING
QUESTION: one question, answerable in a line
OPTIONS: the choices you see, separated by " | ", recommended first

Your session is kept; the answer arrives as your next message and you carry on from where you stopped.
