import React, { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { ArrowLeft, X } from "lucide-react";
import { adminFetch } from "../../lib/adminApi";
import IELTSCDReplica from "../../components/shared/IELTSCDReplica";

const sectionOrder = ["reading", "listening", "writing"];

export default function AdminPreviewPage() {
  const router = useRouter();
  const { examId } = router.query;
  const [exam, setExam] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedSection, setSelectedSection] = useState("reading");

  useEffect(() => {
    if (!examId) return;

    const load = async () => {
      try {
        setLoading(true);
        setError("");
        const data = await adminFetch(`/api/exams/${examId}`, {}, () => {
          router.push("/admin");
        });
        setExam(data);
        const firstSection = sectionOrder.find((type) => (data?.sections || []).some((section) => section.type === type)) || "reading";
        setSelectedSection(firstSection);
      } catch (e) {
        setError(e.message || "Could not load this draft.");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [examId, router]);

  if (loading) {
    return (
      <div className="admin-preview-page loading">
        <div className="admin-preview-shell">Loading draft…</div>
      </div>
    );
  }

  if (error || !exam) {
    return (
      <div className="admin-preview-page error">
        <div className="admin-preview-shell card">
          <h2>Draft preview unavailable</h2>
          <p>{error || "This draft could not be loaded."}</p>
          <button className="admin-preview-back" onClick={() => router.push("/admin")}>
            <ArrowLeft size={16} /> Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  const availableSections = sectionOrder.filter((type) => (exam.sections || []).some((section) => section.type === type));

  return (
    <div className="admin-preview-page">
      <div className="admin-preview-shell">
        <div className="admin-preview-header">
          <div>
            <div className="admin-preview-kicker">Draft preview</div>
            <h1>{exam.title || "Draft preview"}</h1>
          </div>
          <button className="admin-preview-close" onClick={() => router.push("/admin")} aria-label="Close preview">
            <X size={22} />
          </button>
        </div>

        <div className="admin-preview-tabs">
          {availableSections.map((type) => (
            <button
              key={type}
              className={selectedSection === type ? "active" : ""}
              onClick={() => setSelectedSection(type)}
            >
              {type[0].toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>

        <div className="admin-preview-body">
          <IELTSCDReplica
            section={selectedSection}
            examData={{ sections: exam.sections || [] }}
            readOnly={true}
          />
        </div>
      </div>

      <style jsx>{`
        :global(html, body, #__next) {
          margin: 0;
          width: 100%;
          min-height: 100%;
          background: #eef1f5;
          font-family: "Poppins", sans-serif;
        }
        .admin-preview-page {
          min-height: 100vh;
          background: #eef1f5;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 32px;
        }
        .admin-preview-page.loading,
        .admin-preview-page.error {
          background: #eef1f5;
        }
        .admin-preview-shell {
          width: 80vw;
          height: 80vh;
          max-width: 1100px;
          max-height: 780px;
          background: #f5f5f5;
          border: 1px solid #e7e7e7;
          border-radius: 18px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          box-shadow: 0 32px 90px rgba(18, 22, 36, 0.18);
        }
        .admin-preview-shell.card {
          padding: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          flex-direction: column;
          gap: 12px;
        }
        .admin-preview-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 20px 20px 10px;
          border-bottom: 1px solid #eaeaea;
          background: #f5f5f5;
        }
        .admin-preview-kicker {
          text-transform: uppercase;
          letter-spacing: 0.18em;
          color: #7d8798;
          font-weight: 700;
          font-size: 11px;
          margin-bottom: 6px;
        }
        .admin-preview-header h1 {
          margin: 0;
          font-size: clamp(42px, 5vw, 96px);
          letter-spacing: -0.08em;
          line-height: 0.85;
          color: #1d2c4b;
        }
        .admin-preview-close {
          border: none;
          background: transparent;
          color: #1d2c4b;
          cursor: pointer;
          padding: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .admin-preview-tabs {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          padding: 18px 20px 10px;
          background: #f5f5f5;
        }
        .admin-preview-tabs button {
          border: none;
          background: #ebedf0;
          color: #3a4461;
          border-radius: 14px;
          padding: 18px 20px;
          font-size: clamp(18px, 2vw, 30px);
          font-weight: 700;
          letter-spacing: -0.05em;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .admin-preview-tabs button.active {
          background: linear-gradient(135deg, #5b50e6, #6d6ef0);
          color: #fff;
          box-shadow: 0 12px 28px rgba(91, 80, 230, 0.22);
        }
        .admin-preview-body {
          flex: 1;
          background: #fff;
          overflow: auto;
          border-top: 1px solid #ebebeb;
        }
        .admin-preview-back {
          border: 0;
          background: #5b50e6;
          color: white;
          border-radius: 10px;
          padding: 10px 16px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}
