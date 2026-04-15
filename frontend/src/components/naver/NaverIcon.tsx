export function NaverLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="512" height="512" rx="80" fill="#03C75A" />
      <path d="M292.6 278.1L215.2 166H166V346H219.4V233.9L296.8 346H346V166H292.6V278.1Z" fill="white" />
    </svg>
  );
}

export function NaverShoppingIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7 18C5.9 18 5 18.9 5 20S5.9 22 7 22 9 21.1 9 20 8.1 18 7 18ZM1 2V4H3L6.6 11.6L5.2 14.0C5.1 14.3 5 14.7 5 15C5 16.1 5.9 17 7 17H19V15H7.4C7.3 15 7.2 14.9 7.2 14.8V14.7L8.1 13H15.6C16.3 13 16.9 12.6 17.2 12L20.8 5.5C20.9 5.3 21 5.2 21 5C21 4.4 20.6 4 20 4H5.2L4.3 2H1ZM17 18C15.9 18 15 18.9 15 20S15.9 22 17 22 19 21.1 19 20 18.1 18 17 18Z" fill="#03C75A" />
    </svg>
  );
}

export function RankIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 13H5V21H3V13ZM7 7H9V21H7V7ZM11 3H13V21H11V3ZM15 9H17V21H15V9ZM19 5H21V21H19V5Z" fill="#03C75A" />
    </svg>
  );
}
