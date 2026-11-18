
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import motion_pipeline


class TestMotionPipeline(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.model_dir = Path(self.temp_dir.name)
        self.model_patch = patch.object(
            motion_pipeline, "MODEL_DIR", self.model_dir
        )
        self.model_patch.start()

    def tearDown(self):
        self.model_patch.stop()
        self.temp_dir.cleanup()

    def install_fake_torch(self, cuda_available=False):
        fake_torch = SimpleNamespace(
            cuda=SimpleNamespace(
                is_available=lambda: cuda_available,
                get_device_name=lambda index: "GPU de test"
            )
        )
        return patch.dict("sys.modules", {"torch": fake_torch})

    def create_model_files(self):
        for filename in motion_pipeline.REQUIRED_MODEL_FILES:
            (self.model_dir / filename).write_bytes(b"test")

    def test_model_absent(self):
        with self.install_fake_torch(), patch(
            "motion_pipeline.shutil.which", return_value="/usr/bin/ffmpeg"
        ):
            status = motion_pipeline.get_engine_status()

        self.assertFalse(status["model_available"])
        self.assertFalse(status["ready"])

    def test_model_files_missing(self):
        (self.model_dir / "config.json").write_bytes(b"test")

        with self.install_fake_torch(), patch(
            "motion_pipeline.shutil.which", return_value="/usr/bin/ffmpeg"
        ):
            status = motion_pipeline.get_engine_status()

        self.assertFalse(status["model_available"])
        self.assertTrue(status["missing_model_files"])

    def test_model_files_complete(self):
        self.create_model_files()

        with self.install_fake_torch(), patch(
            "motion_pipeline.shutil.which", return_value="/usr/bin/ffmpeg"
        ):
            status = motion_pipeline.get_engine_status()

        self.assertTrue(status["model_available"])
        self.assertEqual(status["missing_model_files"], [])

    def test_gpu_absent(self):
        self.create_model_files()

        with self.install_fake_torch(cuda_available=False), patch(
            "motion_pipeline.shutil.which", return_value="/usr/bin/ffmpeg"
        ):
            status = motion_pipeline.get_engine_status()

        self.assertFalse(status["cuda_available"])
        self.assertFalse(status["ready"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
