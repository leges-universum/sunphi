// Applied before CSS paints; theme is a preference, never a wallet secret.
try {document.documentElement.dataset.theme=localStorage.getItem('sunphi-wallet-theme')==='light'?'light':'dark';} catch {document.documentElement.dataset.theme='dark';}
