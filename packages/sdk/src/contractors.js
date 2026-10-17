/**
 * Contractors and pay runs: invite contractors, contract with them, approve the
 * work they submit and pay the whole team in crypto.
 *
 * An API key is locked to its own business, so `businessId` is optional when
 * the client was created with one. Paying a run needs a signed-in owner
 * (`coinpay login`), never an API key.
 */

const q = (params) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : '';
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const id = (v) => encodeURIComponent(v);

export async function listContractors(client, { businessId, includeOffboarded } = {}) {
  const data = await client.request('/contractors' + q({ business_id: businessId, include_offboarded: includeOffboarded ? 'true' : undefined }));
  return data.contractors ?? [];
}

/** A contractor with contracts (and milestones), work lines and payments. */
export async function getContractor(client, contractorId) {
  return client.request('/contractors/' + id(contractorId));
}

/** Invite a contractor. They are emailed a portal link unless sendInvite is false. */
export async function addContractor(client, { businessId, name, email, country, jobTitle, sendInvite }) {
  const body = { name, email };
  if (businessId) body.business_id = businessId;
  if (country) body.country = country;
  if (jobTitle) body.job_title = jobTitle;
  if (sendInvite === false) body.send_invite = false;
  return client.request('/contractors', json('POST', body));
}

/** Issue a new portal link (the old one stops working). Returns the URL. */
export async function createContractorPortalLink(client, contractorId, { sendEmail } = {}) {
  const data = await client.request(`/contractors/${id(contractorId)}/portal-link`, json('POST', { send_email: !!sendEmail }));
  return data.url;
}

/** Offboard: ends live contracts and revokes the portal link. Records are kept. */
export async function offboardContractor(client, contractorId) {
  return client.request('/contractors/' + id(contractorId), { method: 'DELETE' });
}

/**
 * Draft a contract. kind: 'fixed' (rate per frequency), 'hourly' (rate per
 * hour) or 'milestone' (milestones: [{ title, amount, due_date? }]).
 */
export async function createContract(client, contractorId, { title, scope, kind, rate, frequency, startDate, endDate, firstPayDate, milestones }) {
  const body = { title, kind };
  if (scope) body.scope = scope;
  if (rate !== undefined) body.rate = rate;
  if (frequency) body.frequency = frequency;
  if (startDate) body.start_date = startDate;
  if (endDate) body.end_date = endDate;
  if (firstPayDate) body.first_pay_date = firstPayDate;
  if (milestones) body.milestones = milestones;
  const data = await client.request(`/contractors/${id(contractorId)}/contracts`, json('POST', body));
  return data.contract;
}

/** Sign a draft contract as the business and send it to the contractor. */
export async function sendContract(client, contractId, { signature }) {
  const data = await client.request('/contractor-contracts/' + id(contractId), json('PATCH', { action: 'send', signature }));
  return data.contract;
}

export async function endContract(client, contractId, { reason, endDate } = {}) {
  const data = await client.request('/contractor-contracts/' + id(contractId), json('PATCH', { action: 'end', reason, end_date: endDate }));
  return data.contract;
}

/** Work lines: hours, milestones, expenses, bonuses and fixed fees. status: submitted|approved|rejected|paid */
export async function listWorkItems(client, { businessId, status, contractorId } = {}) {
  const data = await client.request('/contractor-work-items' + q({ business_id: businessId, status, contractor_id: contractorId }));
  return data.work_items ?? [];
}

/** Approve or reject a submission. A rejection needs a note. */
export async function reviewWorkItem(client, workItemId, { action, note }) {
  const data = await client.request('/contractor-work-items/' + id(workItemId), json('PATCH', { action, note }));
  return data.work_item;
}

/** Add a bonus or an expense reimbursement (approved immediately). */
export async function addContractorPayment(client, { businessId, contractId, kind, amount, description }) {
  const body = { contract_id: contractId, kind, amount, description };
  if (businessId) body.business_id = businessId;
  const data = await client.request('/contractor-work-items', json('POST', body));
  return data.work_item;
}

export async function listPayRuns(client, { businessId } = {}) {
  const data = await client.request('/pay-runs' + q({ business_id: businessId }));
  return data.pay_runs ?? [];
}

/** A run with one item per contractor, its lines, and any warnings. */
export async function getPayRun(client, payRunId) {
  return client.request('/pay-runs/' + id(payRunId));
}

/** Draft a pay run (fixed fees due by payDate plus approved work). Moves no money. */
export async function createPayRun(client, { businessId, payDate } = {}) {
  const body = {};
  if (businessId) body.business_id = businessId;
  if (payDate) body.pay_date = payDate;
  const data = await client.request('/pay-runs', json('POST', body));
  return data.pay_run;
}

export async function deletePayRun(client, payRunId) {
  return client.request('/pay-runs/' + id(payRunId), { method: 'DELETE' });
}

/** Send a run (or some items) from the business payout wallet. Owner session only. */
export async function payPayRun(client, payRunId, { itemIds } = {}) {
  return client.request(`/pay-runs/${id(payRunId)}/pay`, json('POST', itemIds ? { method: 'wallet', item_ids: itemIds } : { method: 'wallet' }));
}

/** Record payments made from your own wallet: [{ itemId, txHash }]. Owner session only. */
export async function recordPayRunPayments(client, payRunId, payments) {
  return client.request(
    `/pay-runs/${id(payRunId)}/pay`,
    json('POST', { method: 'manual', payments: payments.map((p) => ({ item_id: p.itemId, tx_hash: p.txHash })) })
  );
}

/** Per-contractor totals for a calendar year and who needs a 1099-NEC. */
export async function get1099Summary(client, { businessId, year } = {}) {
  return client.request('/contractors/1099' + q({ business_id: businessId, year }));
}
