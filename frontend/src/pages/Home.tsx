import Carousel from "../components/Carousel";
import HeroSection from "../components/HeroSection";
import Faq from "../components/FAQ";
import CreateEvent from "../components/CreateEvent";
import FindEvent from "../components/FindEvent";

const Home = () => {
  return (
    <div className="">
      <HeroSection />
      <CreateEvent />
      <FindEvent />
      <Carousel />
      <Faq />
    </div>
  );
};

export default Home;
