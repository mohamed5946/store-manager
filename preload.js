const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),

  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  // Products
  getProducts: () => ipcRenderer.invoke('get-products'),
  saveProduct: (p) => ipcRenderer.invoke('save-product', p),
  deleteProduct: (id) => ipcRenderer.invoke('delete-product', id),

  // Sales
  getSales: () => ipcRenderer.invoke('get-sales'),
  saveSale: (s) => ipcRenderer.invoke('save-sale', s),
  deleteSale: (id) => ipcRenderer.invoke('delete-sale', id),       // was missing

  // Purchases
  getPurchases: () => ipcRenderer.invoke('get-purchases'),
  savePurchase: (p) => ipcRenderer.invoke('save-purchase', p),
  deletePurchase: (id) => ipcRenderer.invoke('delete-purchase', id), // was missing

  // Returns
  getReturns: () => ipcRenderer.invoke('get-returns'),
  saveReturn: (r) => ipcRenderer.invoke('save-return', r),
  deleteReturn: (id) => ipcRenderer.invoke('delete-return', id),    // was missing

  // Customers
  getCustomers: () => ipcRenderer.invoke('get-customers'),
  saveCustomer: (c) => ipcRenderer.invoke('save-customer', c),
  deleteCustomer: (id) => ipcRenderer.invoke('delete-customer', id),

  // Suppliers
  getSuppliers: () => ipcRenderer.invoke('get-suppliers'),
  saveSupplier: (s) => ipcRenderer.invoke('save-supplier', s),
  deleteSupplier: (id) => ipcRenderer.invoke('delete-supplier', id),

  // Expenses
  getExpenses: () => ipcRenderer.invoke('get-expenses'),
  saveExpense: (e) => ipcRenderer.invoke('save-expense', e),
  deleteExpense: (id) => ipcRenderer.invoke('delete-expense', id),

  // Orders
  getOrders: () => ipcRenderer.invoke('get-orders'),
  saveOrder: (o) => ipcRenderer.invoke('save-order', o),           // was missing
  deleteOrder: (id) => ipcRenderer.invoke('delete-order', id),     // was missing

  // Write full snapshot (local disk persistence)
  writeLocalSnapshot: (data) => ipcRenderer.invoke('write-local-snapshot', data),

  // In-app update (Hosting manifest, /updates/)
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
