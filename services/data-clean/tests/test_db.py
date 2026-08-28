import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from db import TaskDB


class TaskDBRetryTests(unittest.TestCase):
    def test_recreating_failed_task_clears_error_and_sets_pending(self):
        with TemporaryDirectory() as root:
            db = TaskDB(Path(root) / "pipeline.db")
            db.create_task("task-1", "https://example.com/old", "web")
            db.update_status("task-1", "failed", error_msg="旧错误")
            created = db.create_task("task-1", "https://example.com/new", "xiaohongshu")
            task = db.get_task("task-1")
        self.assertFalse(created)
        self.assertEqual("pending", task["status"])
        self.assertIsNone(task["error_msg"])
        self.assertEqual("https://example.com/new", task["url"])

    def test_successful_status_update_clears_previous_error(self):
        with TemporaryDirectory() as root:
            db = TaskDB(Path(root) / "pipeline.db")
            db.create_task("task-1", "https://example.com", "web")
            db.update_status("task-1", "failed", error_msg="旧错误")
            db.update_status("task-1", "done", title="完成")
            task = db.get_task("task-1")
        self.assertEqual("done", task["status"])
        self.assertIsNone(task["error_msg"])

    def test_multiple_tasks_delete_in_one_call(self):
        with TemporaryDirectory() as root:
            db = TaskDB(Path(root) / "pipeline.db")
            db.create_task("task-1", "https://example.com/1", "web")
            db.create_task("task-2", "https://example.com/2", "web")
            deleted = db.delete_tasks(["task-1", "task-2", "task-1"])

            self.assertEqual(2, deleted)
            self.assertIsNone(db.get_task("task-1"))
            self.assertIsNone(db.get_task("task-2"))


if __name__ == "__main__":
    unittest.main()
