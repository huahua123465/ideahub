import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

import app as app_module
from db import TaskDB


class BatchDeletionTests(unittest.TestCase):
    @staticmethod
    def _create_task(db, root, task_id):
        db.create_task(task_id, f"https://example.com/{task_id}", "web")
        db.update_status(task_id, "done", title=task_id)
        task_dir = Path(root) / task_id
        task_dir.mkdir()
        (task_dir / "content.json").write_text(
            f'{{"task_id":"{task_id}"}}', encoding="utf-8",
        )
        return task_dir

    def test_batch_delete_removes_all_selected_tasks_once(self):
        with TemporaryDirectory() as root:
            db = TaskDB(Path(root) / "tasks.db")
            first = self._create_task(db, root, "task-1")
            second = self._create_task(db, root, "task-2")
            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "db", db),
                patch.object(app_module, "_running", {}),
            ):
                response = app_module.app.test_client().post(
                    "/api/tasks/batch-delete",
                    json={"task_ids": ["task-1", "task-1", "task-2"]},
                )

            self.assertEqual(200, response.status_code)
            self.assertEqual(2, response.get_json()["deleted_count"])
            self.assertFalse(first.exists())
            self.assertFalse(second.exists())
            self.assertIsNone(db.get_task("task-1"))
            self.assertIsNone(db.get_task("task-2"))

    def test_active_task_blocks_the_entire_batch_before_deletion(self):
        with TemporaryDirectory() as root:
            db = TaskDB(Path(root) / "tasks.db")
            first = self._create_task(db, root, "task-1")
            second = self._create_task(db, root, "task-2")
            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "db", db),
                patch.object(app_module, "_running", {"task-2": {"status": "running"}}),
            ):
                response = app_module.app.test_client().post(
                    "/api/tasks/batch-delete",
                    json={"task_ids": ["task-1", "task-2"]},
                )

            self.assertEqual(409, response.status_code)
            self.assertTrue(first.exists())
            self.assertTrue(second.exists())
            self.assertIsNotNone(db.get_task("task-1"))
            self.assertIsNotNone(db.get_task("task-2"))

    def test_database_failure_restores_every_staged_directory(self):
        with TemporaryDirectory() as root:
            root_path = Path(root)
            task_dirs = []
            for task_id in ("task-1", "task-2"):
                task_dir = root_path / task_id
                task_dir.mkdir()
                (task_dir / "content.json").write_text("keep", encoding="utf-8")
                task_dirs.append(task_dir)
            failing_db = Mock()
            failing_db.get_task.return_value = {"status": "done"}
            failing_db.delete_tasks.side_effect = RuntimeError("database unavailable")

            with (
                patch.object(app_module, "OUTPUT_DIR", root_path),
                patch.object(app_module, "db", failing_db),
                patch.object(app_module, "_running", {}),
            ):
                response = app_module.app.test_client().post(
                    "/api/tasks/batch-delete",
                    json={"task_ids": ["task-1", "task-2"]},
                )

            self.assertEqual(500, response.status_code)
            self.assertTrue(all((path / "content.json").read_text(encoding="utf-8") == "keep" for path in task_dirs))
            self.assertFalse(any(root_path.glob(".delete-batch-*")))


if __name__ == "__main__":
    unittest.main()
