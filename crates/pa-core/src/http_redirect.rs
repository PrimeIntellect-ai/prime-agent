//! Redirect policy for requests carrying credentials or private session data.

/// Keep reqwest's ten-hop limit and same-origin redirects, but never resend a
/// request body or credential to another origin on a 307/308 response.
pub(crate) fn same_origin_only() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt
            .previous()
            .first()
            .is_some_and(|initial| initial.origin() != attempt.url().origin())
        {
            attempt.stop()
        } else {
            reqwest::redirect::Policy::default().redirect(attempt)
        }
    })
}
