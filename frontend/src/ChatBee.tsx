export function ChatBee({
  mood = "idle",
}: {
  mood?: "idle" | "message" | "sent" | "reconnecting";
}) {
  return (
    <svg
      className={`chat-bee chat-bee-${mood}`}
      viewBox="0 0 80 80"
      aria-hidden="true"
    >
      <g
        className="chat-bee-wings"
        fill="#d8f7ff"
        stroke="#153d38"
        strokeWidth="2.5"
      >
        <ellipse
          cx="29"
          cy="28"
          rx="12"
          ry="17"
          transform="rotate(-28 29 28)"
        />
        <ellipse cx="51" cy="28" rx="12" ry="17" transform="rotate(28 51 28)" />
      </g>
      <path
        d="M34 26 29 15M46 26l5-11"
        fill="none"
        stroke="#153d38"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="28" cy="14" r="3" fill="#57d7b0" />
      <circle cx="52" cy="14" r="3" fill="#57d7b0" />
      <path d="m35 65 5 8 5-8" fill="#153d38" />
      <ellipse
        cx="40"
        cy="46"
        rx="23"
        ry="24"
        fill="#ffd260"
        stroke="#153d38"
        strokeWidth="2.5"
      />
      <path
        d="M20 54q20 12 40 0M25 63q15 7 30 0"
        fill="none"
        stroke="#153d38"
        strokeWidth="6"
      />
      <g className="chat-bee-face" fill="#153d38">
        <circle cx="32" cy="40" r="3" />
        <circle cx="48" cy="40" r="3" />
        <path
          d="M35 47q5 6 10 0"
          fill="none"
          stroke="#153d38"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </g>
      <ellipse cx="25" cy="46" rx="4" ry="2" fill="#f29b79" />
      <ellipse cx="55" cy="46" rx="4" ry="2" fill="#f29b79" />
    </svg>
  );
}
