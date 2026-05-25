alter table petrichor_user
    add column if not exists linuxdo_account_id text,
    add column if not exists linuxdo_username text,
    add column if not exists linuxdo_email text;

create unique index if not exists ux_petrichor_user_linuxdo_account_id
    on petrichor_user(linuxdo_account_id)
    where linuxdo_account_id is not null;
