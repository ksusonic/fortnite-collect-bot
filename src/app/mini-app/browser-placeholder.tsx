import styles from "./browser-placeholder.module.css";

export default function BrowserPlaceholder() {
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="telegram-title">
        <div className={styles.icon} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor">
            <path d="M21.5 3.5 18 20l-6-4.5-3 3v-5l8-7-10 6-5-2L21.5 3.5Z" />
          </svg>
        </div>
        <p className={styles.brand}>Fortnite Collect</p>
        <h1 id="telegram-title" className={styles.title}>
          Откройте в Telegram
        </h1>
        <p className={styles.description}>
          Чтобы увидеть статистику своего сквада, откройте Mini App из профиля
          бота в Telegram или по кнопке «Открыть статистику» в групповом чате.
        </p>
        <a className={styles.link} href="https://telegram.org/">
          Скачать Telegram
        </a>
      </section>
    </main>
  );
}
