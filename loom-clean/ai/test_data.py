"""Checks that synthetic labels cannot teach opposite or overlapping edits."""
from pathlib import Path
import unittest
import numpy as np
from train import DefectPatches, load_artwork, deployment_policy, SEED, SPLITS


class DataIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = DefectPatches(load_artwork(Path(__file__).resolve().parents[1] / "sample", "train"), 100, SEED)

    def test_design_groups_are_disjoint(self):
        groups = list(SPLITS.values())
        for i, group in enumerate(groups):
            for other in groups[i + 1:]:
                self.assertFalse(set(group) & set(other))

    def test_add_remove_labels_are_eligible_and_preserve_unchanged_examples(self):
        unchanged_count = positive_count = 0
        for i in range(100):
            ink, target, unchanged = self.data[i]
            ink, target = ink.numpy()[0], target.numpy()
            self.assertEqual(ink.shape, (64, 64))
            self.assertFalse(((target[0] == 1) & (ink != 0)).any())
            self.assertFalse(((target[1] == 1) & (ink != 1)).any())
            self.assertFalse(((target[0] == 1) & (target[1] == 1)).any())
            reconstructed = ink + target[0] - target[1]
            self.assertTrue(np.isin(reconstructed, [0, 1]).all())
            self.assertEqual(int(target[:, :16].sum() + target[:, 48:].sum() + target[:, :, :16].sum() + target[:, :, 48:].sum()), 0)
            if unchanged:
                unchanged_count += 1
                self.assertEqual(target.sum(), 0)
            positive_count += int(target.sum())
        self.assertGreater(unchanged_count, 15)
        self.assertGreater(positive_count, 100)

    def test_sample_seed_is_reproducible(self):
        a = self.data[23]
        b = self.data[23]
        np.testing.assert_array_equal(a[0].numpy(), b[0].numpy())
        np.testing.assert_array_equal(a[1].numpy(), b[1].numpy())
        self.assertEqual(a[2], b[2])

    def test_failed_validation_head_is_disabled_without_erasing_measured_threshold(self):
        measurements = {"add": {"threshold": 0.988, "precision": 0.95, "recall": 0.014},
                        "remove": {"threshold": 0.995, "precision": 0.981, "recall": 0.295}}
        policy = deployment_policy(measurements, {"add": False, "remove": True}, 0.98)
        self.assertEqual(policy["disabledHeads"], ["add"])
        self.assertEqual(policy["thresholds"], {"add": 1.0, "remove": 0.995})
        self.assertEqual(policy["calibratedThresholds"]["add"], 0.988)
        self.assertIn("Validation", policy["disabledHeadReasons"]["add"])


if __name__ == "__main__":
    unittest.main()
