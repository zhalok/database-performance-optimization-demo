create table if not exists tickets (
    id serial primary key,
    seat_no varchar(256),
    from_location varchar(100),
    to_location varchar(100),
    bus_company varchar(100),
    is_booked boolean,
    price int,
    travel_date date,
    travel_time time
);

create table if not exists bookings (
    id serial primary key,
    user_id int,
    ticket_id int
);