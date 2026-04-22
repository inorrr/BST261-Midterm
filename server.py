import argparse
import csv
import json
import random
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CSV_PATH = ROOT / "mock_exam_questions.csv"
EXAM_SIZE = 15
BASE_FIELDS = [
    "id",
    "question",
    "choice(c)",
    "correct answer",
    "which concept this question belongs to",
    "times_appeared",
    "times_correct",
]


def read_questions():
    with CSV_PATH.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    changed = False
    for index, row in enumerate(rows, start=1):
        if not row.get("id"):
            row["id"] = str(index)
            changed = True
        for field in ("times_appeared", "times_correct"):
            if row.get(field, "") == "":
                row[field] = "0"
                changed = True

    if changed:
        write_questions(rows)
    return rows


def write_questions(rows):
    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=BASE_FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in BASE_FIELDS})


def reset_history():
    rows = read_questions()
    for row in rows:
        row["times_appeared"] = "0"
        row["times_correct"] = "0"
    write_questions(rows)
    return len(rows)


def int_value(row, field):
    try:
        return int(row.get(field, 0) or 0)
    except ValueError:
        return 0


def question_weight(row):
    appeared = int_value(row, "times_appeared")
    correct = int_value(row, "times_correct")
    accuracy = correct / appeared if appeared else 0

    # Unseen questions get the strongest pull. Once seen, low-accuracy questions
    # remain more likely than questions the student consistently answers right.
    exposure_bonus = 4 / (1 + appeared)
    weakness_bonus = 1.2 if appeared == 0 else 1 + (1 - accuracy) * 2.5
    return exposure_bonus * weakness_bonus


def choose_weighted(rows, count):
    pool = list(rows)
    selected = []
    for _ in range(min(count, len(pool))):
        weights = [question_weight(row) for row in pool]
        choice = random.choices(pool, weights=weights, k=1)[0]
        selected.append(choice)
        pool.remove(choice)
    return selected


def public_question(row):
    return {
        "id": row["id"],
        "question": row["question"],
        "choice(c)": row["choice(c)"],
        "correct answer": row["correct answer"],
        "which concept this question belongs to": row["which concept this question belongs to"],
        "times_appeared": int_value(row, "times_appeared"),
        "times_correct": int_value(row, "times_correct"),
    }


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/start-exam":
            self.start_exam()
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/submit":
            self.submit_exam()
            return
        self.send_error(404, "Unknown endpoint")

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        return json.loads(body or "{}")

    def start_exam(self):
        rows = read_questions()
        selected = choose_weighted(rows, EXAM_SIZE)
        selected_ids = {row["id"] for row in selected}

        for row in rows:
            if row["id"] in selected_ids:
                row["times_appeared"] = str(int_value(row, "times_appeared") + 1)

        write_questions(rows)
        fresh_by_id = {row["id"]: row for row in rows}
        self.send_json(200, {
            "questions": [public_question(fresh_by_id[row["id"]]) for row in selected],
            "exam_size": EXAM_SIZE,
        })

    def submit_exam(self):
        try:
            payload = self.read_json()
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Invalid JSON"})
            return

        answers = payload.get("answers", {})
        if not isinstance(answers, dict):
            self.send_json(400, {"error": "answers must be an object keyed by question id"})
            return

        rows = read_questions()
        by_id = {row["id"]: row for row in rows}
        correct_ids = []

        for question_id, selected in answers.items():
            row = by_id.get(str(question_id))
            if not row:
                continue
            if str(selected).strip() == row["correct answer"].strip():
                row["times_correct"] = str(int_value(row, "times_correct") + 1)
                correct_ids.append(str(question_id))

        write_questions(rows)
        self.send_json(200, {
            "updated": len(answers),
            "correct_ids": correct_ids,
        })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run or maintain the BST 261 mock exam app.")
    parser.add_argument(
        "--reset-history",
        action="store_true",
        help="Set times_appeared and times_correct to 0 for every question, then exit.",
    )
    args = parser.parse_args()

    if args.reset_history:
        count = reset_history()
        print(f"Reset history for {count} questions.")
        raise SystemExit(0)

    server = ThreadingHTTPServer(("127.0.0.1", 8000), Handler)
    print("Serving BST 261 mock exam at http://127.0.0.1:8000/index.html")
    server.serve_forever()
