import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

const DialogContext = createContext(null);

export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolverRef = useRef(null);
  const confirmButtonRef = useRef(null);

  const confirm = useCallback((options) => {
    return new Promise((resolve) => {
      setDialog({
        title: options?.title || 'Please confirm',
        message: options?.message || '',
        summary: Array.isArray(options?.summary) ? options.summary : [],
        danger: options?.danger ?? false,
        confirmLabel: options?.confirmLabel || 'Confirm',
        cancelLabel: options?.cancelLabel || 'Cancel',
      });
      resolverRef.current = resolve;
    });
  }, []);

  const close = useCallback((confirmed) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setDialog(null);
    if (resolve) resolve(confirmed);
  }, []);

  useEffect(() => {
    if (!dialog) return undefined;
    confirmButtonRef.current?.focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [dialog, close]);

  return (
    <DialogContext.Provider value={{ confirm }}>
      {children}
      {dialog && (
        <div
          data-testid="dialog-overlay"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="crowdpay-dialog-title"
            aria-describedby={
              dialog.message ? 'crowdpay-dialog-description' : undefined
            }
            style={{
              background: 'var(--color-surface)',
              borderRadius: '10px',
              padding: '1.5rem',
              maxWidth: '460px',
              width: '90%',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)',
            }}
          >
            <h2
              id="crowdpay-dialog-title"
              style={{
                margin: '0 0 0.75rem',
                fontSize: '1.15rem',
                fontWeight: 800,
                color: 'var(--color-text-primary)',
              }}
            >
              {dialog.title}
            </h2>

            {dialog.message && (
              <p
                id="crowdpay-dialog-description"
                style={{
                  margin: '0 0 1rem',
                  fontSize: '0.92rem',
                  color: 'var(--color-text-secondary)',
                  lineHeight: 1.55,
                }}
              >
                {dialog.message}
              </p>
            )}

            {dialog.summary.length > 0 && (
              <dl
                style={{
                  margin: '0 0 1rem',
                  display: 'grid',
                  gap: '0.4rem',
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border-light)',
                  borderRadius: '8px',
                  padding: '0.85rem 1rem',
                }}
              >
                {dialog.summary.map((item, i) => (
                  <div
                    key={item.label ?? i}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: '0.75rem',
                    }}
                  >
                    <dt style={{ color: 'var(--color-text-hint)', fontSize: '0.85rem' }}>
                      {item.label}
                    </dt>
                    <dd
                      style={{
                        margin: 0,
                        minWidth: 0,
                        textAlign: 'right',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        color: 'var(--color-text-primary)',
                        wordBreak: 'break-all',
                        fontFamily: item.monospace ? 'monospace' : 'inherit',
                      }}
                    >
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '0.75rem',
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={() => close(false)}
              >
                {dialog.cancelLabel}
              </button>
              <button
                type="button"
                className="btn-primary"
                ref={confirmButtonRef}
                onClick={() => close(true)}
                style={
                  dialog.danger
                    ? {
                        background: 'var(--color-error-text, #dc2626)',
                        borderColor: 'var(--color-error-text, #dc2626)',
                        color: '#fff',
                      }
                    : undefined
                }
              >
                {dialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}

export const useDialog = () => useContext(DialogContext);
