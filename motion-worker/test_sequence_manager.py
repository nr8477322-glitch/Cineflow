
import tempfile
import unittest

from pathlib import Path
from unittest.mock import patch

from sequence_manager import (
    SequenceManagerError,
    generate_film,
)


class SequenceManagerTests(unittest.TestCase):

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)

        self.sequences = [
            {
                "image_url": "https://example.com/image1.png",
                "prompt": "Personnage marchant dans une rue.",
                "duration_seconds": 5,
                "aspect_ratio": "16:9",
            },
            {
                "image_url": "https://example.com/image2.png",
                "prompt": "Personnage entrant dans un bâtiment.",
                "duration_seconds": 5,
                "aspect_ratio": "16:9",
            },
        ]

    def tearDown(self):
        self.temp.cleanup()

    def fake_generator(self, **kwargs):
        path = self.directory / f"segment-{len(list(self.directory.glob('segment-*')))}.mp4"
        path.write_bytes(b"fake-mp4")

        return {
            "job_id": "fake-job",
            "status": "completed",
            "video_path": str(path),
            "video_url": "/videos/" + path.name,
        }

    def fake_ffmpeg(self, command, **kwargs):
        output = Path(command[-1])
        output.write_bytes(b"fake-final-mp4")

    def test_rejects_empty_sequences(self):
        with self.assertRaises(SequenceManagerError):
            generate_film(
                [],
                output_dir=self.directory,
                generator=self.fake_generator,
            )

    def test_rejects_duration_above_10_seconds(self):
        sequences = [dict(self.sequences[0])]
        sequences[0]["duration_seconds"] = 11

        with self.assertRaises(SequenceManagerError):
            generate_film(
                sequences,
                output_dir=self.directory,
                generator=self.fake_generator,
            )

    def test_rejects_film_above_10_minutes(self):
        sequences = [
            dict(self.sequences[0], duration_seconds=10)
            for _ in range(61)
        ]

        with self.assertRaises(SequenceManagerError):
            generate_film(
                sequences,
                output_dir=self.directory,
                generator=self.fake_generator,
            )

    def test_generates_and_assembles_two_segments(self):
        with patch(
            "sequence_manager.subprocess.run",
            side_effect=self.fake_ffmpeg,
        ) as ffmpeg:

            result = generate_film(
                self.sequences,
                output_dir=self.directory,
                generator=self.fake_generator,
            )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["duration_seconds"], 10)
        self.assertEqual(result["segments_count"], 2)
        self.assertTrue(Path(result["video_path"]).is_file())
        self.assertEqual(ffmpeg.call_count, 1)

        for segment in result["segment_paths"]:
            self.assertTrue(Path(segment).is_file())

    def test_rejects_missing_generated_video(self):
        def bad_generator(**kwargs):
            return {
                "status": "completed",
                "video_path": str(self.directory / "missing.mp4"),
            }

        with self.assertRaises(SequenceManagerError):
            generate_film(
                self.sequences,
                output_dir=self.directory,
                generator=bad_generator,
            )

    def test_ffmpeg_failure_does_not_leave_final_video(self):
        with patch(
            "sequence_manager.subprocess.run",
            side_effect=RuntimeError("simulated FFmpeg failure"),
        ):
            with self.assertRaises(SequenceManagerError):
                generate_film(
                    self.sequences,
                    output_dir=self.directory,
                    generator=self.fake_generator,
                )

        self.assertEqual(
            list(self.directory.glob("film-*.mp4")),
            [],
        )


if __name__ == "__main__":
    unittest.main()
