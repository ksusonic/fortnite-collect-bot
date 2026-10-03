CREATE TABLE IF NOT EXISTS job_http_requests (
    request_id bigint PRIMARY KEY, job text NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    status_code integer, timed_out boolean, error text
);
CREATE INDEX IF NOT EXISTS job_http_pending ON job_http_requests(requested_at) WHERE completed_at IS NULL;
ALTER TABLE job_http_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON job_http_requests FROM PUBLIC;
