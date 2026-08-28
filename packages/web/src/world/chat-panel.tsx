import { useEffect, useRef, useState } from "react";
import type { ChatScope, LobbyChatMessage } from "../backend/protocol.js";

type ChatPanelProps = {
  messages: LobbyChatMessage[];
  sector: string | null;
  disabled: boolean;
  onSend: (message: string, scope: ChatScope) => void;
};

export function ChatPanel({ messages, sector, disabled, onSend }: ChatPanelProps) {
  const [scope, setScope] = useState<ChatScope>("world");
  const [draft, setDraft] = useState("");
  // 숨기기·확대는 CSS에서 모바일에서만 보이는 버튼이다. 상태는 데스크톱에서도 유지한다.
  const [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const feed = useRef<HTMLDivElement>(null);

  const visible = scope === "world" ? messages : messages.filter((message) => message.scope === "sector");

  useEffect(() => {
    // 새 메시지는 아래에 쌓이므로 항상 맨 아래를 보여준다.
    const element = feed.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [visible.length]);

  return (
    <aside className={`world-chat${expanded ? " is-expanded" : ""}${minimized ? " is-minimized" : ""}`}>
      <header>
        <span className="chat-heading">
          <b>CHAT</b>
          <em>{visible.length}</em>
        </span>
        <span className="chat-header-actions">
          <button
            className="chat-minimize-button"
            type="button"
            aria-label="채팅 숨기기"
            onClick={() => setMinimized(true)}
          >
            숨기기
          </button>
          <button
            className="chat-expand-button"
            type="button"
            aria-label="채팅 전체화면으로 열기"
            onClick={() => setExpanded((previous) => !previous)}
          >
            {expanded ? "축소" : "확대"}
          </button>
        </span>
      </header>
      <div className="chat-filters" role="group" aria-label="채팅 필터">
        <button
          type="button"
          className={scope === "world" ? "is-active" : ""}
          aria-label="전체 채팅 보기"
          onClick={() => setScope("world")}
        >
          전체
        </button>
        <button
          type="button"
          className={scope === "sector" ? "is-active" : ""}
          aria-label={`주변 칸 ${sector ?? "--"} 채팅만 보기`}
          onClick={() => setScope("sector")}
        >
          주변 {sector ?? "--"}
        </button>
      </div>
      <div className="chat-feed" ref={feed}>
        {visible.map((message) => (
          <p key={message.id}>
            <small>{message.scope === "world" ? "WORLD" : message.sector ?? "SECTOR"}</small>
            <b>{message.nickname}</b>
            <span>{message.message}</span>
          </p>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSend(draft, scope);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={disabled ? "이동하면 채팅할 수 있어요" : "메시지"}
          disabled={disabled}
          maxLength={200}
        />
        <button type="submit" disabled={disabled || !draft.trim()}>
          전송
        </button>
      </form>
    </aside>
  );
}
