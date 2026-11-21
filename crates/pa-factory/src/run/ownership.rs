//! Run ownership: the session that can advance a run, and the takeover of
//! a run whose owner ended.
//!
//! A run has one owner session. Any session can read the run. Only the
//! owner can get mutable access to it ([`OwnedRun::advance`]). When the
//! owner session ends, the executor records it with
//! [`OwnedRun::abandon`]. The run then waits in
//! [`Ownership::Abandoned`] until a session takes it over with
//! [`OwnedRun::take_over`]. The run does not stay stuck without a
//! visible state, and no session gets the run without that transition.

use std::fmt;

use super::Run;

/// The owner state of one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ownership {
    /// This session owns the run and is the only session that can
    /// advance it.
    Owned { session: String },
    /// The owner session ended. The run waits for a takeover.
    Abandoned { last_owner: String },
}

/// A request that the run's ownership does not accept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnershipError {
    /// Another session owns the run.
    NotOwner { owner: String, caller: String },
    /// The owner ended. A session must take over the run before it
    /// advances it.
    Abandoned { last_owner: String, caller: String },
}

impl fmt::Display for OwnershipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotOwner { owner, caller } => write!(
                f,
                "session {caller} cannot change this run: session {owner} owns it"
            ),
            Self::Abandoned { last_owner, caller } => write!(
                f,
                "session {caller} cannot change this run: its owner {last_owner} ended; take over the run first"
            ),
        }
    }
}

impl std::error::Error for OwnershipError {}

/// A run with its owner. Reads are open to all sessions. Changes go
/// through [`OwnedRun::advance`], which only the owner can call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedRun {
    run: Run,
    ownership: Ownership,
}

impl OwnedRun {
    /// Give a run to the session that started it.
    #[must_use]
    pub fn new(run: Run, owner: &str) -> Self {
        Self {
            run,
            ownership: Ownership::Owned {
                session: owner.to_string(),
            },
        }
    }

    #[must_use]
    pub fn run(&self) -> &Run {
        &self.run
    }

    #[must_use]
    pub fn ownership(&self) -> &Ownership {
        &self.ownership
    }

    /// Get mutable access to the run for `caller`.
    ///
    /// # Errors
    ///
    /// Returns [`OwnershipError::NotOwner`] with the owner's name when
    /// another session owns the run. Returns
    /// [`OwnershipError::Abandoned`] when the owner ended and no session
    /// took over the run.
    pub fn advance(&mut self, caller: &str) -> Result<&mut Run, OwnershipError> {
        self.check_owner(caller)?;
        Ok(&mut self.run)
    }

    /// Record that the owner session `owner` ended. The run becomes
    /// claimable. The run status does not change: children in flight
    /// keep running.
    ///
    /// # Errors
    ///
    /// Returns [`OwnershipError::NotOwner`] when `owner` is not the
    /// current owner, for example a late report about a session that
    /// lost the run in a takeover. Returns [`OwnershipError::Abandoned`]
    /// when the run is abandoned already.
    pub fn abandon(&mut self, owner: &str) -> Result<(), OwnershipError> {
        self.check_owner(owner)?;
        self.ownership = Ownership::Abandoned {
            last_owner: owner.to_string(),
        };
        Ok(())
    }

    /// Give an abandoned run to `session`.
    ///
    /// # Errors
    ///
    /// Returns [`OwnershipError::NotOwner`] with the owner's name when a
    /// live session owns the run. A takeover cannot remove a live owner.
    pub fn take_over(&mut self, session: &str) -> Result<(), OwnershipError> {
        match &self.ownership {
            Ownership::Abandoned { .. } => {
                self.ownership = Ownership::Owned {
                    session: session.to_string(),
                };
                Ok(())
            }
            Ownership::Owned { session: owner } => Err(OwnershipError::NotOwner {
                owner: owner.clone(),
                caller: session.to_string(),
            }),
        }
    }

    fn check_owner(&self, caller: &str) -> Result<(), OwnershipError> {
        match &self.ownership {
            Ownership::Owned { session } if session == caller => Ok(()),
            Ownership::Owned { session } => Err(OwnershipError::NotOwner {
                owner: session.clone(),
                caller: caller.to_string(),
            }),
            Ownership::Abandoned { last_owner } => Err(OwnershipError::Abandoned {
                last_owner: last_owner.clone(),
                caller: caller.to_string(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::run::{RunEvent, RunStatus};

    fn owned_by(owner: &str) -> OwnedRun {
        let spec = json!({"states": [{"id": "a"}], "transitions": []});
        OwnedRun::new(Run::start(&spec, 0).unwrap(), owner)
    }

    #[test]
    fn the_owner_advances_its_run() {
        let mut run = owned_by("s1");
        let status = run.advance("s1").unwrap().apply(RunEvent::Finish, 0);
        assert_eq!(status, Ok(RunStatus::Done));
    }

    #[test]
    fn a_non_owner_cannot_advance_the_run_and_the_error_names_the_owner() {
        let mut run = owned_by("s1");
        let refused = run.advance("s2").map(|_| ());
        assert_eq!(
            refused,
            Err(OwnershipError::NotOwner {
                owner: "s1".to_string(),
                caller: "s2".to_string(),
            })
        );
        assert_eq!(
            refused.unwrap_err().to_string(),
            "session s2 cannot change this run: session s1 owns it"
        );
        assert_eq!(run.run().status(), RunStatus::Running);
    }

    #[test]
    fn an_abandoned_run_refuses_every_session_until_a_takeover() {
        let mut run = owned_by("s1");
        run.abandon("s1").unwrap();
        assert_eq!(
            run.advance("s1").map(|_| ()),
            Err(OwnershipError::Abandoned {
                last_owner: "s1".to_string(),
                caller: "s1".to_string(),
            })
        );
        assert_eq!(
            run.ownership(),
            &Ownership::Abandoned {
                last_owner: "s1".to_string()
            }
        );
    }

    #[test]
    fn a_takeover_makes_the_new_session_the_owner() {
        let mut run = owned_by("s1");
        run.abandon("s1").unwrap();
        run.take_over("s2").unwrap();
        assert_eq!(
            run.ownership(),
            &Ownership::Owned {
                session: "s2".to_string()
            }
        );
        assert!(run.advance("s2").is_ok());
    }

    #[test]
    fn a_late_abandon_from_a_former_owner_does_not_release_the_run() {
        let mut run = owned_by("s1");
        run.abandon("s1").unwrap();
        run.take_over("s2").unwrap();
        assert_eq!(
            run.abandon("s1"),
            Err(OwnershipError::NotOwner {
                owner: "s2".to_string(),
                caller: "s1".to_string(),
            })
        );
    }

    #[test]
    fn a_takeover_of_a_live_owners_run_is_an_illegal_transition() {
        let mut run = owned_by("s1");
        assert_eq!(
            run.take_over("s2"),
            Err(OwnershipError::NotOwner {
                owner: "s1".to_string(),
                caller: "s2".to_string(),
            })
        );
        assert_eq!(
            run.ownership(),
            &Ownership::Owned {
                session: "s1".to_string()
            }
        );
    }
}
