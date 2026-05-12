type MidnightLogoProps = {
  className?: string;
  title?: string;
};

export function MidnightLogo({ className, title = "Midnight" }: MidnightLogoProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 26 26"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
    >
      <path
        d="M12.5089 0.5C5.59981 0.5 0 6.09581 0 13C0 19.9042 5.59981 25.5 12.5089 25.5C19.4181 25.5 25.0179 19.9042 25.0179 13C25.0179 6.09581 19.4181 0.5 12.5089 0.5ZM12.5089 23.1945C6.88273 23.1945 2.30715 18.6204 2.30715 13C2.30715 7.37957 6.88273 2.8055 12.5089 2.8055C18.1351 2.8055 22.7107 7.37957 22.7107 13C22.7107 18.6204 18.1334 23.1945 12.5089 23.1945Z"
        fill="white"
      />
      <path d="M13.6827 11.8271H11.3351V14.1731H13.6827V11.8271Z" fill="white" />
      <path d="M13.6827 8.12158H11.3351V10.4675H13.6827V8.12158Z" fill="white" />
      <path d="M13.6827 4.41797H11.3351V6.76392H13.6827V4.41797Z" fill="white" />
    </svg>
  );
}
