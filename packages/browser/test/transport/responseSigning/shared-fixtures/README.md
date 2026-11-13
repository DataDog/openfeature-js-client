These are byte-for-byte snapshots of the shared response-signing supplements at
DataDog/ffe-system-test-data commit e60a71adb18e14acd8d37339d4a11281629fff2c.
The manifest retains their independently generated hashes.

The shared fixture PR is not merged, so the existing submodule remains on main.
Once the fixtures land, update its pin and load these cases from that submodule,
then remove these snapshots. Tests explicitly execute every supplemental case.
