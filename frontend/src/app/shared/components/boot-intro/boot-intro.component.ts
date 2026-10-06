import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, type OnDestroy, type OnInit, inject, output, signal } from '@angular/core';

/** Full intro length, then the fade-out; reduced motion skips straight to a short fade. */
const INTRO_HOLD_MS = 2800;
const INTRO_FADE_MS = 700;
const REDUCED_MOTION_HOLD_MS = 300;

/** Boot screen: a slow-moving blue wallpaper, the eye logo fading in and blinking, a thin progress bar. */
@Component({
  selector: 'app-boot-intro',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <div class="boot-intro" [class.boot-intro--leaving]="leaving()" role="presentation" aria-hidden="true">
      <div class="boot-intro__wallpaper">
        <span class="boot-intro__blob boot-intro__blob--a"></span>
        <span class="boot-intro__blob boot-intro__blob--b"></span>
        <span class="boot-intro__blob boot-intro__blob--c"></span>
      </div>
      <div class="boot-intro__center">
        <svg class="boot-intro__eye" viewBox="0 0 60 34">
          <g class="boot-intro__lid">
            <path d="M3 17C14 4 46 4 57 17C46 30 14 30 3 17Z" fill="none" stroke="currentColor" stroke-width="2.5" />
            <circle cx="30" cy="17" r="7" fill="none" stroke="currentColor" stroke-width="2.5" />
            <path d="M30 10A7 7 0 0 1 30 24Z" fill="currentColor" />
          </g>
        </svg>
        <div class="boot-intro__name">PRVision</div>
        <div class="boot-intro__bar"><span class="boot-intro__fill"></span></div>
      </div>
    </div>
  `,
  styles: `
    .boot-intro {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: grid;
      place-items: center;
      overflow: hidden;
      background: #04060b;
      color: #f5f7fb;
      transition: opacity ${INTRO_FADE_MS}ms ease, filter ${INTRO_FADE_MS}ms ease;
    }
    .boot-intro--leaving {
      opacity: 0;
      filter: blur(6px);
      pointer-events: none;
    }
    .boot-intro__wallpaper {
      position: absolute;
      inset: -20%;
      filter: blur(80px) saturate(140%);
      opacity: 0;
      animation: boot-fade-in 1.2s ease forwards;
    }
    .boot-intro__blob {
      position: absolute;
      width: 55vmax;
      height: 55vmax;
      border-radius: 9999px;
      opacity: 0.55;
    }
    .boot-intro__blob--a {
      left: 5%;
      top: 10%;
      background: radial-gradient(circle, #2563eb 0%, transparent 65%);
      animation: boot-drift-a 9s ease-in-out infinite alternate;
    }
    .boot-intro__blob--b {
      right: 0;
      top: 30%;
      background: radial-gradient(circle, #0ea5e9 0%, transparent 65%);
      animation: boot-drift-b 11s ease-in-out infinite alternate;
    }
    .boot-intro__blob--c {
      left: 30%;
      bottom: -10%;
      background: radial-gradient(circle, #4f46e5 0%, transparent 65%);
      animation: boot-drift-c 13s ease-in-out infinite alternate;
    }
    .boot-intro__center {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.25rem;
    }
    .boot-intro__eye {
      width: 88px;
      height: 50px;
      opacity: 0;
      transform: scale(0.88);
      animation: boot-logo-in 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) 0.3s forwards;
    }
    .boot-intro__lid {
      transform-box: fill-box;
      transform-origin: center;
      animation: boot-blink 0.32s ease-in-out 1.35s;
    }
    .boot-intro__name {
      font-family: var(--font-display, inherit);
      font-size: 1.375rem;
      font-weight: 600;
      letter-spacing: -0.01em;
      opacity: 0;
      transform: translateY(6px);
      animation: boot-name-in 0.8s ease 0.8s forwards;
    }
    .boot-intro__bar {
      width: 160px;
      height: 3px;
      margin-top: 1.5rem;
      border-radius: 9999px;
      background: rgba(255, 255, 255, 0.14);
      overflow: hidden;
      opacity: 0;
      animation: boot-fade-in 0.4s ease 0.9s forwards;
    }
    .boot-intro__fill {
      display: block;
      height: 100%;
      width: 100%;
      border-radius: inherit;
      background: #f5f7fb;
      transform: scaleX(0);
      transform-origin: left;
      animation: boot-fill 1.6s cubic-bezier(0.45, 0, 0.2, 1) 1s forwards;
    }
    @keyframes boot-fade-in {
      to {
        opacity: 1;
      }
    }
    @keyframes boot-logo-in {
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
    @keyframes boot-name-in {
      to {
        opacity: 0.92;
        transform: translateY(0);
      }
    }
    @keyframes boot-blink {
      50% {
        transform: scaleY(0.08);
      }
    }
    @keyframes boot-fill {
      to {
        transform: scaleX(1);
      }
    }
    @keyframes boot-drift-a {
      to {
        transform: translate(12vmax, 8vmax) scale(1.15);
      }
    }
    @keyframes boot-drift-b {
      to {
        transform: translate(-14vmax, -6vmax) scale(0.9);
      }
    }
    @keyframes boot-drift-c {
      to {
        transform: translate(-6vmax, -12vmax) scale(1.1);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .boot-intro *,
      .boot-intro {
        animation: none !important;
        transition: opacity 200ms ease !important;
      }
      .boot-intro__wallpaper,
      .boot-intro__eye,
      .boot-intro__name,
      .boot-intro__bar {
        opacity: 1;
        transform: none;
      }
    }
  `,
})
export class BootIntroComponent implements OnInit, OnDestroy {
  readonly finished = output();

  protected readonly leaving = signal(false);
  private readonly document = inject(DOCUMENT);
  private readonly timers: ReturnType<typeof setTimeout>[] = [];

  ngOnInit(): void {
    const reduced = this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const hold = reduced ? REDUCED_MOTION_HOLD_MS : INTRO_HOLD_MS;
    const fade = reduced ? 200 : INTRO_FADE_MS;
    this.timers.push(setTimeout(() => this.leaving.set(true), hold));
    this.timers.push(setTimeout(() => this.finished.emit(), hold + fade));
  }

  ngOnDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }
}
