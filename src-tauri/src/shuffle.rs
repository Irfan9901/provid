use rand::seq::SliceRandom;
use rand::thread_rng;

pub fn shuffle_list(mut list: Vec<String>) -> Vec<String> {
    let mut rng = thread_rng();
    list.shuffle(&mut rng);
    list
}
