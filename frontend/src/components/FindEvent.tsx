import { Tickets } from "lucide-react";
import { Link } from "react-router-dom";

const FindEvent = () => {
  return (
    <div className="px-7 my-20 ">
      <h1 className="text-4xl font-bold py-5">Discover Events</h1>
      <p>Explore popular events near you, browse by category, or check out some of the great community calendars.</p>
      {/* <div className="flex">
        <img
          className="w-full max-h-64 opacity-50 object-cover"
          src="https://plus.unsplash.com/premium_photo-1661963284298-bc47a4027799?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1yZWxhdGVkfDU5fHx8ZW58MHx8fHx8"
          alt=""
        />
      </div> */}
      <div className="event-tags flex flex-wrap gap-6 items-center justify-center">
        {[
          "Arts",
          "Technology",
          "Fashion",
          "Gadgets",
          "religion",
          "clubs",
          "comedy",
        ].map((link) => (
          <Link
            key={link}
            to={`/${link}`}
            aria-label={`Browse ${link} events`}
            className="relative inline-flex items-center justify-center w-20 h-20 sm:w-36 sm:h-36 md:w-40 md:h-40"
          >
            <Tickets className="absolute inset-0 w-full h-full text-orange-500" />
            <span className="relative z-10 text-sm md:text-sm font-semibold text-orange-900">
              {link}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
};

export default FindEvent;
