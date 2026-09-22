<!-- pa:per-model-instructions
Per-model instructions append to the static prompt layers for sessions whose
resolved model selector matches one of the block patterns. A block starts
with a header line "<!-- pa:model:" followed by a comma-separated list of
model selector patterns and "-->", ends with "<!-- /pa:model -->", and holds
the instruction text between the two. In a pattern, "*" matches any run of
characters; a bare "*" matches every model. Multiple blocks may match; they
apply in file order. There are no per-model instructions yet.
-->

<!-- pa:model: * -->

<!-- /pa:model -->
