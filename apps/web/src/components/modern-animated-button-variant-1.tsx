import type { ReactNode } from "react"

interface ModernAnimatedButtonVariant1Props {
  href?: string
  ariaLabel?: string
  title?: ReactNode
  subtitle?: ReactNode
  className?: string
}

export default function ModernAnimatedButtonVariant1({
  href = "https://github.com/CiZaii",
  ariaLabel = "访问我的 GitHub 主页：CiZaii",
  title = "GitHub：CiZaii",
  subtitle = "点击访问",
  className,
}: ModernAnimatedButtonVariant1Props) {
  return (
    <>
      <style>
        {`
        /* 使用 @property 声明自定义属性，以获得更顺滑的动画插值 */
        @property --r2 {
          syntax: "<angle>";
          inherits: false;
          initial-value: 0deg;
        }

        @property --x {
          syntax: "<length-percentage>";
          inherits: false;
          initial-value: 20px;
        }

        .github-rotation-animation {
          animation: githubRotationKeyFrames 3s linear -.64s infinite, githubTranslationKeyFrames 3s linear -.64s infinite;
        }

        /* 旋转动画 */
        @keyframes githubRotationKeyFrames {
          0% {
            --r2: 0deg;
          }
          32.8228% {
            --r2: 0deg;
          }
          50% {
            --r2: 180deg;
          }
          82.8228% {
            --r2: 180deg;
          }
          100% {
            --r2: 360deg;
          }
        }

        /* x 轴位移动画 */
        @keyframes githubTranslationKeyFrames {
          0% {
            --x: 20px;
          }
          32.8228% {
            --x: calc(100% - 20px);
          }
          50% {
            --x: calc(100% - 20px);
          }
          82.8228% {
            --x: 20px;
          }
          100% {
            --x: 20px;
          }
        }
      `}
      </style>
      <a
        aria-label={ariaLabel}
        className={[
          "inline-flex shrink-0",
          "github-rotation-animation conic-gradient transform-gpu cursor-pointer rounded-full p-px shadow-[0_0_20px_0_rgba(245,48,107,0.1)] hue-rotate-[190deg] invert transition-all hover:bg-[#782a2b] hover:shadow-[0_0_20px_3px_rgba(245,49,108,.2)] dark:hue-rotate-0 dark:invert-0",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        href={href}
        rel="noreferrer noopener"
        style={{
          background:
            "conic-gradient(from calc(var(--r2) - 80deg) at var(--x) 15px, transparent 0, #eca5a7 20%, transparent 25%), #452324",
        }}
        target="_blank"
      >
        <span className="pointer-events-none flex h-7 flex-nowrap items-center gap-2 rounded-full bg-[#120d0e] px-3 py-1 font-medium text-[#eca5a7] text-sm tracking-tighter">
          <span className="whitespace-nowrap">{title}</span>
          {subtitle ? (
            <>
              <span className="h-5/6 w-px bg-neutral-700/50" />
              <span className="whitespace-nowrap text-neutral-500">{subtitle}</span>
            </>
          ) : null}
        </span>
      </a>
    </>
  )
}
