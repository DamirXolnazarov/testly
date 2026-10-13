import React from "react";
import { useRouter } from "next/router";
import ExamEditor from "../../components/admin/ExamEditor";

// The test editor for one exam. Reached from the draft preview, an exam
// card, or AI Studio; ExamEditor itself bounces to /admin when the admin
// token is missing or expired.
export default function AdminEditorPage() {
  const router = useRouter();
  const { examId } = router.query;
  if (!examId) return null;
  return (
    <ExamEditor
      examId={examId}
      onBack={() => router.push("/admin")}
      onPreview={() => router.push(`/admin-preview/${examId}`)}
    />
  );
}
