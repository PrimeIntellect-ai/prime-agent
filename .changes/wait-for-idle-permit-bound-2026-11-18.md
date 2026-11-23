- Bound explicit `wait_for_idle` slices so abandoned waits release worker permits; omitted budgets still allow long waits.
  See [discussion #4078](https://github.com/PrimeIntellect-ai/prime-agent/discussions/4078).
