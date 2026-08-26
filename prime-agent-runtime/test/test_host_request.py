from __future__ import annotations

import asyncio
import os
import unittest
from unittest.mock import patch

import rlm


class HostRequestAvailabilityTest(unittest.TestCase):
    def test_rejects_unadvertised_request_before_opening_a_comm(self) -> None:
        with (
            patch.dict(
                os.environ,
                {rlm.HOST_REQUEST_TYPES_ENV: '["rlm.run"]'},
                clear=False,
            ),
            patch.object(rlm, "Comm") as comm,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                'host request type "rlm_heartbeat.list" is not available in this session',
            ):
                asyncio.run(rlm.host_request("rlm_heartbeat.list"))

        comm.assert_not_called()


if __name__ == "__main__":
    unittest.main()
