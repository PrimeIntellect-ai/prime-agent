Fixed sessions wedging on the provider's request-size limit: any HTTP 413 now arms the request-size compaction and retries the turn.

